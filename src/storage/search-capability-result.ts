import type { Database } from "bun:sqlite";
import { RunConflictError, RunFenceError } from "../domain/run";
import type { SearchCapabilityResult } from "../domain/search-capability";
import { searchCapabilityFullRead, searchCapabilityReferences } from "../domain/search-capability-result";
import { mergeSearchReferences, searchReferencesEligible } from "./search-eligibility";
import { searchContextResultReferences } from "./search-capability-context";
import type { ContextRef } from "../domain/run";

export function searchResultReferences(db: Database, runId: string, result: SearchCapabilityResult): readonly ContextRef[] {
  return mergeSearchReferences(searchCapabilityReferences(result),searchContextResultReferences(db,runId,result));
}

/** Cache/successor delivery may use durable witnesses, but must never create missing exposure/full-read authority. */
export function confirmSearchResult(db: Database, runId: string, result: SearchCapabilityResult): void {
  const refs = searchResultReferences(db,runId,result), fullRead = searchCapabilityFullRead(result);
  for (const ref of refs) {
    const witness = db.query("SELECT full_read AS fullRead FROM run_context WHERE run_id=? AND kind=? AND ref_id=?")
      .get(runId,ref.kind,ref.id) as { fullRead: number } | null;
    if (!witness || (fullRead && ref.kind === fullRead.kind && ref.id === fullRead.id && witness.fullRead !== 1)) {
      throw new RunConflictError("Search result has no matching durable exposure witness");
    }
  }
  if (!searchReferencesEligible(db,refs)) throw new RunFenceError("Search result sources are unavailable");
}
