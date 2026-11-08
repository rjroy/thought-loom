import { receiptMatches, validUploadKey } from "./request";
import type { MediaClient, MediaImportWorkspace, MediaUploadResult, MediaUploadSnapshot } from "./types";

const empty = (): MediaImportWorkspace => ({ file: null, clarification: "", admission: "editing", snapshot: null,
  receipt: null, checking: false, receiptCheck: "none", problem: null, selectionError: null });
const supported = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

/** Mounted-memory command owner. Reads never write; unresolved commands keep their original key. */
export function createMediaImportController(client: MediaClient, newKey: () => string = () => crypto.randomUUID()) {
  let state = empty();
  const listeners = new Set<() => void>();
  const update = (change: Partial<MediaImportWorkspace>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const editable = () => state.admission === "editing" || state.admission === "not-started";
  async function upload(snapshot: MediaUploadSnapshot, recovering: boolean) {
    update({ admission: "pending", snapshot, receiptCheck: "none", problem: null });
    let result: MediaUploadResult;
    try { result = await client.upload(snapshot); }
    catch { result = { kind: "uncertain", problem: { status: null, code: null } }; }
    if (result.kind === "confirmed" && receiptMatches(result.receipt, snapshot)) {
      update({ admission: "saved", receipt: result.receipt, file: null, snapshot: null, problem: null });
    } else {
      // A refused resend cannot disprove the earlier ambiguous admission.
      update({ admission: recovering || result.kind !== "not-started" ? "uncertain" : "not-started",
        problem: result.kind === "confirmed" ? { status: null, code: null } : result.problem });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(file: File) {
      if (!editable()) return;
      if (!supported.has(file.type) || file.size === 0) {
        update({ selectionError: "Choose a nonempty PNG, JPEG, GIF, WebP or PDF. No file was sent." });
        return;
      }
      update({ file, admission: "editing", snapshot: null, problem: null, selectionError: null, receiptCheck: "none" });
    },
    setClarification(clarification: string) {
      if (!editable() || clarification === state.clarification) return;
      update({ clarification, admission: "editing", snapshot: null, problem: null, receiptCheck: "none" });
    },
    async submit() {
      if (!editable() || !state.file || state.selectionError) return;
      let snapshot = state.snapshot;
      if (!snapshot) {
        let key: string;
        try { key = newKey(); } catch { update({ selectionError: "Could not prepare this upload. No file was sent." }); return; }
        if (!validUploadKey(key)) { update({ selectionError: "Could not prepare this upload. No file was sent." }); return; }
        snapshot = Object.freeze({ file: state.file, clarification: state.clarification.trim() ? state.clarification : null, key });
      }
      await upload(snapshot, false);
    },
    async checkUpload() {
      if (state.admission !== "uncertain" || state.checking || !state.snapshot) return;
      const snapshot = state.snapshot;
      update({ checking: true });
      try {
        const result = await client.byKey(snapshot.key);
        if (result.kind === "confirmed" && receiptMatches(result.receipt, snapshot)) {
          update({ admission: "saved", receipt: result.receipt, file: null, snapshot: null, receiptCheck: "none", problem: null });
        } else update({ receiptCheck: result.kind === "absent" ? "absent" : "error" });
      } catch { update({ receiptCheck: "error" }); }
      finally { update({ checking: false }); }
    },
    async resendUpload() {
      if (state.admission !== "uncertain" || state.checking || state.receiptCheck !== "absent" || !state.snapshot) return;
      await upload(state.snapshot, true);
    },
    reset() { if (state.admission !== "pending" && state.admission !== "uncertain") { state = empty(); for (const listener of listeners) listener(); } },
  };
}
