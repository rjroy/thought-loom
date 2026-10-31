import { DIALOGUE_PREVIEW_MAX_CHARACTERS, type DialoguePreview } from "@thoughtloom/contracts";
import type { WeavingRun } from "./weaving";

export type NativeTextEvent = { id: string; sessionID: string; assistantMessageID: string; ordinal: number } &
  ({ type: "session.text.started" } | { type: "session.text.delta"; delta: string } | { type: "session.text.ended"; text: string });
export type TextSubscription = { close(): Promise<void> };
export type SubscribeText = (sessionId: string, onEvent: (event: NativeTextEvent) => void, onGap: () => void) => Promise<TextSubscription>;
export type PreviewLimits = { maxCharacters: number; maxFragments: number; maxEventIds: number; ttlMs: number };
const defaults: PreviewLimits = { maxCharacters: DIALOGUE_PREVIEW_MAX_CHARACTERS, maxFragments: 128, maxEventIds: 4_096, ttlMs: 300_000 };
type Fragment = { text: string; open: boolean; truncated: boolean };
type Checkpoint = { epoch: number };

export function previewLimits(input?: PreviewLimits): PreviewLimits {
  const limits = { ...defaults, ...input };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      limits.maxCharacters > DIALOGUE_PREVIEW_MAX_CHARACTERS || limits.maxFragments > 1_024 || limits.maxEventIds > 65_536 || limits.ttlMs > 3_600_000) {
    throw new Error("Invalid preview limits");
  }
  return limits;
}

// One immutable owned run, with bounded unverified fragments. No preview is
// readable until ordered ordinary history authorizes its assistant message ID.
export class DialoguePreviewMonitor {
  private readonly fragments = new Map<string, Map<number, Fragment>>();
  private readonly eventIds = new Set<string>();
  private authorized: string | undefined;
  private characters = 0;
  private fragmentCount = 0;
  private saturated = false;
  private epoch = 0;
  private lastActivity: number;
  private subscription: TextSubscription | undefined;
  private connecting: Promise<void> | undefined;
  private connected = false;
  private serial = 0;
  private retryAt = 0;
  private retryMs = 1_000;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(readonly run: WeavingRun, private readonly subscribe: SubscribeText, private readonly limits: PreviewLimits, private readonly now: () => number) {
    this.lastActivity = now();
  }

  matches(run: WeavingRun): boolean {
    return this.run.runId === run.runId && this.run.jobId === run.jobId && this.run.sourceId === run.sourceId &&
      this.run.sessionId === run.sessionId && this.run.promptId === run.promptId;
  }

  checkpoint(): Checkpoint { this.expire(); return { epoch: this.epoch }; }

  async ensure(): Promise<void> {
    this.expire();
    if (this.closed || this.connected || this.now() < this.retryAt) return;
    if (this.connecting) return this.connecting;
    const task = this.connect();
    this.connecting = task;
    try { await task; } finally { this.connecting = undefined; }
  }

  private async connect(): Promise<void> {
    const serial = ++this.serial;
    // Closing/reopening is itself a gap, even if a late old subscriber delivered
    // another start after its first disconnect notification.
    this.reset(false);
    const old = this.subscription; this.subscription = undefined;
    console.info("dialogue.preview connect attempt", { runId: this.run.runId });
    try {
      await old?.close();
      if (this.closed) return;
      let gapped = false;
      const subscription = await this.subscribe(this.run.sessionId,
        (event) => { if (!this.closed && serial === this.serial) this.receive(event); },
        () => {
          if (this.closed || serial !== this.serial) return;
          gapped = true; this.connected = false; this.reset(false);
          this.retryAt = this.now() + this.retryMs;
          this.retryMs = Math.min(this.retryMs * 2, 10_000);
          console.warn("dialogue.preview disconnected", { runId: this.run.runId });
        });
      if (this.closed || serial !== this.serial) { await subscription.close(); return; }
      this.subscription = subscription; this.connected = !gapped;
      if (!gapped) this.retryMs = 1_000;
      console.info("dialogue.preview connect outcome", { runId: this.run.runId, connected: this.connected });
    } catch {
      this.connected = false; this.reset(false);
      this.retryAt = this.now() + this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
      console.warn("dialogue.preview connect unavailable", { runId: this.run.runId });
    }
  }

  private reset(clearIdentity: boolean): void {
    this.fragments.clear(); this.eventIds.clear(); this.characters = 0; this.fragmentCount = 0; this.saturated = false;
    this.epoch++; this.lastActivity = this.now();
    if (clearIdentity) this.authorized = undefined;
  }

  reject(category = "unverified_history"): void {
    if (this.authorized || this.fragments.size) console.warn("dialogue.preview invalidated", { runId: this.run.runId, category });
    this.reset(true);
  }

  private expire(): void {
    if (this.closed || this.now() - this.lastActivity < this.limits.ttlMs) return;
    this.reset(true); this.connected = false;
    console.info("dialogue.preview expired", { runId: this.run.runId });
  }

  private part(messageId: string, ordinal: number): Fragment | undefined { return this.fragments.get(messageId)?.get(ordinal); }

  private put(messageId: string, ordinal: number, text: string, open: boolean, alreadyTruncated = false): void {
    const previous = this.part(messageId, ordinal);
    if (!previous && this.fragmentCount >= this.limits.maxFragments) {
      this.dropOpenFragments(); this.saturated = true;
      if (this.fragmentCount >= this.limits.maxFragments) return;
    }
    const available = Math.max(0, this.limits.maxCharacters - this.characters + (previous?.text.length ?? 0));
    const kept = text.slice(0, available);
    let parts = this.fragments.get(messageId);
    if (!parts) { parts = new Map(); this.fragments.set(messageId, parts); }
    parts.set(ordinal, { text: kept, open, truncated: alreadyTruncated || text.length > available });
    this.characters += kept.length - (previous?.text.length ?? 0);
    if (!previous) this.fragmentCount++;
  }

  private dropOpenFragments(): void {
    for (const [messageId, parts] of this.fragments) {
      for (const [ordinal, part] of parts) if (part.open) {
        this.characters -= part.text.length; this.fragmentCount--; parts.delete(ordinal);
      }
      if (!parts.size) this.fragments.delete(messageId);
    }
  }

  private receive(event: NativeTextEvent): void {
    this.expire();
    if (event.sessionID !== this.run.sessionId || typeof event.id !== "string" || !event.id.length || event.id.length > 256 ||
        typeof event.assistantMessageID !== "string" || !event.assistantMessageID.startsWith("msg_") || event.assistantMessageID.length > 256 ||
        !Number.isSafeInteger(event.ordinal) || event.ordinal < 0 || this.eventIds.has(event.id)) return;
    if (this.eventIds.size >= this.limits.maxEventIds) {
      // Never evict IDs and then append a replayed delta. Full ended values can
      // still repair a fragment; deltas wait for a fresh connection epoch.
      if (!this.saturated) this.dropOpenFragments();
      this.saturated = true;
    } else this.eventIds.add(event.id);
    this.lastActivity = this.now();
    const part = this.part(event.assistantMessageID, event.ordinal);
    if (event.type === "session.text.ended" && typeof event.text === "string") {
      this.put(event.assistantMessageID, event.ordinal, event.text, false);
    } else if (!this.saturated && event.type === "session.text.started" && !part) {
      this.put(event.assistantMessageID, event.ordinal, "", true);
    } else if (!this.saturated && event.type === "session.text.delta" && typeof event.delta === "string" && part?.open) {
      this.put(event.assistantMessageID, event.ordinal, part.text + event.delta.slice(0, this.limits.maxCharacters), true,
        part.truncated || event.delta.length > this.limits.maxCharacters);
    }
  }

  correlate(messageId: string | undefined, textParts: readonly string[] | undefined, checkpoint: Checkpoint): void {
    this.expire();
    if (this.closed || checkpoint.epoch !== this.epoch) return;
    this.authorized = messageId;
    // A message may have started after the history query began. Retain bounded
    // unverified events for the next inspection; absence is not foreign input.
    if (!messageId) return;
    // Pinned native history persists text only on text.ended. An empty open
    // part is not a snapshot of its missing prefix and must not enable append.
    for (const [ordinal, text] of (textParts ?? []).entries()) {
      if (ordinal >= this.limits.maxFragments) break;
      if (text && !this.part(messageId, ordinal)) this.put(messageId, ordinal, text, false);
    }
  }

  peek(): DialoguePreview | undefined {
    this.expire();
    if (this.closed || !this.authorized) return;
    const parts = this.fragments.get(this.authorized);
    if (!parts?.size) return;
    const ordered = [...parts].sort(([a], [b]) => a - b).map(([, part]) => part);
    const text = ordered.map((part) => part.text).join("\n");
    return { runId: this.run.runId, messageId: this.authorized, text: text.slice(0, this.limits.maxCharacters),
      truncated: this.saturated || text.length > this.limits.maxCharacters || ordered.some((part) => part.truncated) };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.serial++; this.reset(true);
    console.info("dialogue.preview release attempt", { runId: this.run.runId });
    return this.closing = (async () => {
      await this.connecting;
      const subscription = this.subscription; this.subscription = undefined;
      await subscription?.close();
      console.info("dialogue.preview release outcome", { runId: this.run.runId });
    })();
  }
}
