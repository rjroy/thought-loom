import { validRun } from "../features/evolve/validation";
import type { RunStatus } from "../features/evolve/types";
import { record } from "../features/idea/validation";

export type Speaker = "user" | "ai";
export interface Session {
  readonly id: string;
  readonly anchorThoughtId: string;
  readonly continuationThoughtId: string;
  readonly mode: "ideas-only";
  readonly createdAt: string;
}
export interface Passage { readonly speaker: Speaker; readonly text: string; readonly parentId: string }
export interface Save extends Passage {
  readonly thoughtId: string;
  readonly selectedBy: Speaker;
  readonly source: "passage" | "synthesis";
  readonly sourceTurnId?: string;
  readonly start: number | null;
}
export interface Turn {
  readonly id: string;
  readonly parentId: string;
  readonly text: string;
  readonly status: RunStatus | "pending";
  readonly admittedAt: string;
  readonly runId: string | null;
  readonly reply: string | null;
  readonly saves: readonly Save[];
}
export type AdmissionObservation = Pick<Turn, "id" | "parentId" | "text" | "status" | "admittedAt" | "runId">;
export interface PagedTurn extends Turn {
  readonly savesHasMore: boolean;
  readonly savesNextAfter: string | null;
}
export interface ConversationPage { readonly session: Session; readonly turns: readonly PagedTurn[]; readonly nextBefore: string | null }
interface SavePage { readonly saves: readonly Save[]; readonly nextAfter: string | null }
export type Pending =
  | { readonly kind: "send"; readonly key: string }
  | { readonly kind: "keep"; readonly key: string; readonly turnId: string };

const nonblank = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const speaker = (value: unknown): value is Speaker => value === "user" || value === "ai";
const isSession = (value: unknown): value is Session => record(value) && nonblank(value.id)
  && nonblank(value.anchorThoughtId) && nonblank(value.continuationThoughtId)
  && value.mode === "ideas-only" && nonblank(value.createdAt);
const isSave = (value: unknown): value is Save => record(value) && nonblank(value.thoughtId) && nonblank(value.parentId)
  && speaker(value.speaker) && speaker(value.selectedBy) && nonblank(value.text)
  && (value.sourceTurnId === undefined || nonblank(value.sourceTurnId))
  && (value.source === "passage" && typeof value.start === "number" && Number.isSafeInteger(value.start) && value.start >= 0
    || value.source === "synthesis" && value.speaker === "ai" && value.start === null);
const isTurn = (value: unknown): value is Turn => record(value) && nonblank(value.id) && nonblank(value.parentId)
  && nonblank(value.admittedAt) && nonblank(value.text) && (value.runId === null || nonblank(value.runId))
  && (value.reply === null || nonblank(value.reply))
  && typeof value.status === "string" && ["pending", "queued", "submitting", "running", "uncertain", "completed", "interrupted", "failed"].includes(value.status)
  && Array.isArray(value.saves) && value.saves.every(isSave)
  && new Set(value.saves.map(save => save.thoughtId)).size === value.saves.length;

export const conversationHref = (id: string) => `/evolve?conversationId=${encodeURIComponent(id)}`;
export const freshEvolveHref = (id: string) => `/evolve?thoughtId=${encodeURIComponent(id)}`;
const base = "/api/evolve-sessions";
const sessionPath = (id: string) => `${base}/${encodeURIComponent(id)}`;
const savesPath = (id: string, turnId: string) => `${sessionPath(id)}/turns/${encodeURIComponent(turnId)}/saves`;

type Result<T> = { readonly kind: "ok"; readonly value: T } |
  { readonly kind: "refused"; readonly status: number; readonly code?: "stale-continuation" } |
  { readonly kind: "unknown"; readonly status: number };
async function request<T>(path: string, parse: (value: unknown) => T | null,
  write?: { method: "POST" | "PUT"; body: object; key?: string }): Promise<Result<T>> {
  const method = write?.method ?? "GET";
  try {
    const headers = new Headers();
    if (write) headers.set("Content-Type", "application/json");
    if (write?.key) headers.set("Idempotency-Key", write.key);
    const response = await fetch(path, {
      method, headers, body: write ? JSON.stringify(write.body) : undefined, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if ([400, 401, 403, 404, 409, 413, 415, 422].includes(response.status)) {
      if (response.status === 409) {
        const value: unknown = await response.json().catch(() => null);
        if (record(value) && value.code === "stale-continuation") return { kind: "refused", status: 409, code: "stale-continuation" };
      }
      return { kind: "refused", status: response.status };
    }
    if (response.status === 200 || (method === "POST" && response.status === 201)) {
      const value = parse(await response.json());
      if (value !== null) return { kind: "ok", value };
    }
    return { kind: "unknown", status: response.status };
  } catch { return { kind: "unknown", status: 0 }; }
}

function sessionEnvelope(value: unknown, expected?: { id?: string; anchor?: string; parent?: string }): Session | null {
  if (!record(value) || !isSession(value.session)) return null;
  const session = value.session;
  return (expected?.id === undefined || session.id === expected.id)
    && (expected?.anchor === undefined || session.anchorThoughtId === expected.anchor)
    && (expected?.parent === undefined || session.continuationThoughtId === expected.parent) ? session : null;
}

function admission(value: unknown, id: string, snapshot?: { parentId: string; text: string }): AdmissionObservation | null {
  if (!record(value) || !record(value.receipt) || !isTurn(value.turn)) return null;
  const turn = value.turn;
  if (value.receipt.sessionId !== id || value.receipt.turnId !== turn.id || value.receipt.admittedAt !== turn.admittedAt
    || (turn.runId === null ? value.run !== null : !validRun(value.run, turn.runId))
    || (snapshot && (turn.parentId !== snapshot.parentId || turn.text !== snapshot.text))) return null;
  // Receipt mode has placeholder content. Return only identity and status so
  // callers cannot accidentally publish its null reply or empty save list.
  return { id: turn.id, parentId: turn.parentId, text: turn.text, status: turn.status, admittedAt: turn.admittedAt, runId: turn.runId };
}

function manualReceipt(value: unknown, snapshot?: Passage): Save | null {
  if (!record(value) || !isSave(value.receipt)) return null;
  const save = value.receipt;
  return save.selectedBy === "user" && save.source === "passage" && save.sourceTurnId === undefined
    && (!snapshot || (save.parentId === snapshot.parentId && save.speaker === snapshot.speaker && save.text === snapshot.text)) ? save : null;
}

export const selectiveClient = {
  create: (anchor: string) => request(base, value => sessionEnvelope(value, { anchor, parent: anchor }),
    { method: "POST", body: { anchorThoughtId: anchor } }),
  read: (id: string, before?: string) => request(`${sessionPath(id)}${pageQuery("before", before)}`, (value): ConversationPage | null => {
    const session = sessionEnvelope(value, { id });
    return session && record(value) && validCursor(value.nextBefore) && value.nextBefore !== before
      && Array.isArray(value.turns) && value.turns.length <= pageSize && value.turns.every(isPagedTurn)
      && new Set(value.turns.map(turn => turn.id)).size === value.turns.length
      && (before === undefined || !value.turns.some(turn => turn.id === before))
      && (value.nextBefore === null || value.nextBefore === value.turns[0]?.id)
      ? { session, turns: value.turns, nextBefore: value.nextBefore } : null;
  }),
  readSaves: (id: string, turn: string, after?: string) => request(`${savesPath(id, turn)}${pageQuery("after", after)}`, (value): SavePage | null =>
    record(value) && validCursor(value.nextAfter) && value.nextAfter !== after && Array.isArray(value.saves)
    && value.saves.length <= pageSize && value.saves.every(isSave)
    && new Set(value.saves.map(save => save.thoughtId)).size === value.saves.length
    && (after === undefined || !value.saves.some(save => save.thoughtId === after))
    && (value.nextAfter === null || value.nextAfter === value.saves.at(-1)?.thoughtId) ? { saves: value.saves, nextAfter: value.nextAfter } : null),
  send: (id: string, key: string, snapshot: { parentId: string; text: string }) => request(`${sessionPath(id)}/turns?view=receipt`,
    value => admission(value, id, snapshot), { method: "POST", body: { ...snapshot, expectedContinuationThoughtId: snapshot.parentId }, key }),
  checkSend: (id: string, key: string, snapshot?: { parentId: string; text: string }) =>
    request(`${sessionPath(id)}/turns/by-key/${encodeURIComponent(key)}?view=receipt`, value => admission(value, id, snapshot)),
  keep: (id: string, turn: string, key: string, snapshot: Passage) => request(savesPath(id, turn),
    value => manualReceipt(value, snapshot), { method: "POST", body: snapshot, key }),
  checkKeep: (id: string, turn: string, key: string, snapshot?: Passage) => request(`${savesPath(id, turn)}/by-key/${encodeURIComponent(key)}`,
    value => manualReceipt(value, snapshot)),
  continueAt: (id: string, anchor: string, thoughtId: string, expectedContinuationThoughtId: string) =>
    request(`${sessionPath(id)}/continuation`, value => sessionEnvelope(value, { id, anchor, parent: thoughtId }),
      { method: "PUT", body: { thoughtId, expectedContinuationThoughtId } }),
  observe: (id: string) => request(`/api/evolve/runs/${encodeURIComponent(id)}`, value => validRun(value, id) ? value : null),
  stop: (id: string) => request(`/api/evolve/runs/${encodeURIComponent(id)}`, value => validRun(value, id) ? value : null,
    { method: "POST", body: {} }),
};

const pageSize = 20;
const validCursor = (value: unknown): value is string | null => value === null || nonblank(value);
function pageQuery(parameter: "before" | "after", cursor?: string): string {
  const params = new URLSearchParams({ limit: String(pageSize) });
  if (cursor !== undefined) params.set(parameter, cursor);
  return `?${params}`;
}
function isPagedTurn(value: unknown): value is PagedTurn {
  if (!record(value)) return false;
  const { savesHasMore, savesNextAfter } = value;
  return isTurn(value) && typeof savesHasMore === "boolean" && validCursor(savesNextAfter)
    && (savesHasMore ? (savesNextAfter !== null) === (value.saves.length > 0) : savesNextAfter === null)
    && (savesNextAfter === null || savesNextAfter === value.saves.at(-1)?.thoughtId)
    && value.saves.length <= pageSize;
}

// A History entry contains only an opaque ID; draft words stay in the current document.
let inspectedDraft: { historyMarker: string; conversationId: string; text: string } | null = null;
const draftMarker = "thoughtloomEvolveInspection";
export function rememberInspection(conversationId: string, text: string): void {
  try {
    const historyMarker = [...crypto.getRandomValues(new Uint32Array(4))].join("-");
    window.history.replaceState({ ...window.history.state, [draftMarker]: historyMarker }, "");
    inspectedDraft = { historyMarker, conversationId, text };
  } catch { /* A history API failure must not block opening the idea. */ }
}
export function inspectionReturn(conversationId?: string | null): typeof inspectedDraft {
  const draft = inspectedDraft;
  return draft && (!conversationId || conversationId === draft.conversationId)
    && window.history.state?.[draftMarker] === draft.historyMarker
    && window.location.pathname + window.location.search === conversationHref(draft.conversationId) ? draft : null;
}
export function takeInspectionReturn(conversationId: string): typeof inspectedDraft {
  const draft = inspectionReturn(conversationId);
  if (draft) inspectedDraft = null;
  return draft;
}

const journalName = (id: string) => `thoughtloom.evolve.pending:${id}`;
export function readPending(id: string): Pending | null {
  const raw = sessionStorage.getItem(journalName(id));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!record(value) || typeof value.key !== "string" || !/^[a-f0-9-]{36}$/.test(value.key)) throw new Error("Invalid request recovery.");
  if (value.kind === "send") return { kind: "send", key: value.key };
  if (value.kind === "keep" && nonblank(value.turnId)) return { kind: "keep", key: value.key, turnId: value.turnId };
  throw new Error("Invalid request recovery.");
}
export function writePending(id: string, pending: Pending): void {
  if (readPending(id)) throw new Error("Another request is awaiting confirmation.");
  const name = journalName(id), value = JSON.stringify(pending);
  sessionStorage.setItem(name, value);
  if (sessionStorage.getItem(name) !== value) throw new Error("Request recovery is unavailable.");
}
export function clearPending(id: string, pending: Pending): void {
  if (readPending(id)?.key === pending.key) sessionStorage.removeItem(journalName(id));
}
