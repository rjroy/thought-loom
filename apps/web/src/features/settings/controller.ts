import type { AgentInstructionsClient, InstructionReadResult, InstructionSaveResult } from "./request";
import { emptyInstructionDraft, instructionDraft, instructionErrors, instructionTextError, sameInstructions,
  type AgentInstructions, type InstructionDraft, type InstructionErrors, type InstructionField } from "./types";

export interface SettingsState {
  readonly phase: "idle" | "loading" | "ready" | "read-error";
  readonly baseline: AgentInstructions | null;
  readonly draft: InstructionDraft;
  readonly pending: AgentInstructions | null;
  readonly fieldErrors: InstructionErrors;
  readonly problem: { readonly kind: "read" | "save" | "conflict"; readonly message: string } | null;
  readonly saved: boolean;
}

export const settingsDirty = (state: SettingsState): boolean => state.baseline !== null && !sameInstructions(state.draft, state.baseline);
export const settingsCanSave = (state: SettingsState): boolean => state.phase === "ready" && state.baseline !== null && state.pending === null
  && state.problem?.kind !== "conflict" && (settingsDirty(state) || state.problem?.kind === "save");
const initialState = (): SettingsState => ({ phase: "idle", baseline: null, draft: emptyInstructionDraft(), pending: null, fieldErrors: {}, problem: null, saved: false });
const readProblem = "Instructions could not be loaded. Reload this page to try again. Nothing has been changed.";
const conflictProblem = "Changes were not saved because these instructions changed elsewhere. Your edits are still here. Copy them before reloading this page to review the current settings.";

/** The confirmed baseline, current edits and submitted snapshot have separate lifetimes. */
export function createSettingsController(client: AgentInstructionsClient) {
  let state = initialState(), generation = 0;
  let active: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (change: Partial<SettingsState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const disconnect = () => { generation++; active?.abort(); active = null; };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Disconnect drops observation, not a write that the server may already have accepted. */
    disconnect,
    async load() {
      if (state.pending) return;
      disconnect();
      const current = generation, abort = new AbortController();
      active = abort;
      state = { ...initialState(), phase: "loading" };
      publish({});
      let result: InstructionReadResult;
      try { result = await client.read(abort.signal); } catch { result = { kind: "error" }; }
      if (generation !== current || abort.signal.aborted) return;
      active = null;
      if (result.kind === "error") { publish({ phase: "read-error", problem: { kind: "read", message: readProblem } }); return; }
      publish({ phase: "ready", baseline: result.instructions, draft: instructionDraft(result.instructions) });
    },
    edit(field: InstructionField, value: string) {
      if (!state.baseline || state.draft[field] === value) return;
      const errors = { ...state.fieldErrors };
      // Once a field has shown an error, keep its feedback current while it is edited.
      if (errors[field]) {
        const message = instructionTextError(value);
        if (message) errors[field] = message; else delete errors[field];
      }
      publish({ draft: { ...state.draft, [field]: value }, fieldErrors: errors, saved: false });
    },
    async save() {
      if (!settingsCanSave(state) || !state.baseline) return;
      const errors = instructionErrors(state.draft);
      if (Object.keys(errors).length) { publish({ fieldErrors: errors, saved: false }); return; }
      const snapshot: AgentInstructions = Object.freeze({ ...state.draft, revision: state.baseline.revision });
      const current = generation, abort = new AbortController();
      active = abort;
      publish({ pending: snapshot, fieldErrors: {}, problem: null, saved: false });
      let result: InstructionSaveResult;
      try { result = await client.save(snapshot, abort.signal); } catch { result = { kind: "error", reason: "unavailable" }; }
      if (generation !== current || abort.signal.aborted || state.pending !== snapshot) return;
      active = null;
      if (result.kind === "success") {
        // Never replace the live draft with the earlier submitted value.
        publish({ baseline: result.instructions, pending: null, saved: true });
      } else if (result.kind === "conflict") {
        publish({ pending: null, problem: { kind: "conflict", message: conflictProblem } });
      } else {
        const message = result.reason === "invalid" ? "Changes were not saved. Check that each field contains valid text within the 16 KiB UTF-8 limit. Your edits are still here."
          : result.reason === "forbidden" ? "Changes were not saved because Settings access is unavailable. Your edits are still here. Copy them before reloading this page."
          : "Changes were not saved or could not be confirmed. Your edits are still here. You can try Save changes again; nothing will be sent automatically.";
        publish({ pending: null, problem: { kind: "save", message } });
      }
    },
  };
}

export type SettingsController = ReturnType<typeof createSettingsController>;
