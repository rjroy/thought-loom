import type { Logger } from "../logging";
import { RunFenceError } from "../domain/run";
import type { SearchCleanupIdentity, SearchCleanupObservation } from "./search-cleanup-contract";
import { AgentBindingError } from "./binding";
import type { NativeSession, PublicClient } from "./opencode-adapter";
import { searchHistoryFacts, type SearchHistoryFacts } from "./search-cleanup-history";

/** Same decoded SDK transport, with cancellation-only authority and strict binding verification supplied by the adapter. */
export async function reconcileSearchCancellation(client: PublicClient, identity: SearchCleanupIdentity, authorize: () => void,
  verify: (session: NativeSession) => void, logger: Logger): Promise<SearchCleanupObservation> {
  const binding = identity.binding;
  const authorizedCount = identity.manifest.steps.filter(step => step.authorization === "authorized-uncertain").length;
  const call = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    authorize();
    logger.verbose("[search cleanup] native attempt",{runId:identity.runId,operation});
    try {
      const value = await action(); authorize();
      logger.verbose("[search cleanup] native succeeded",{runId:identity.runId,operation});
      return value;
    } catch (error) {
      authorize(); logger.verbose("[search cleanup] native unresolved",{runId:identity.runId,operation});
      throw error;
    }
  };
  const observe = async (): Promise<SearchHistoryFacts> => {
    verify(await call("session.get",() => client.sessionGet({sessionID:binding.sessionId})));
    // Keep decoded prose only for this owned read, then return metadata facts. Cursor loops never count as completion.
    const messages: Awaited<ReturnType<PublicClient["history"]>>["data"][number][] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await call("message.list",() => client.history({sessionID:binding.sessionId,order:"asc",...(cursor === undefined ? {} : {cursor})}));
      for (const message of page.data) messages.push(message);
      cursor = page.cursor.next;
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor))) throw new AgentBindingError("Search native history cursor differs");
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    const inbox = await call("inbox.list",() => client.inbox({sessionID:binding.sessionId}));
    const active = await call("session.active",() => client.active());
    verify(await call("session.get",() => client.sessionGet({sessionID:binding.sessionId})));
    return searchHistoryFacts(identity,messages,inbox,active);
  };
  try {
    authorize();
    if (client.serviceUrl !== undefined && client.serviceUrl !== binding.serviceUrl) throw new AgentBindingError("Search cleanup endpoint differs");
    let facts = await observe();
    for (const inboxID of facts.inboxIds) {
      const fresh = await observe();
      if (!fresh.whollyOwned) return {state:"pending",admissions:fresh.admissions,prompts:fresh.prompts,
        inactive:fresh.inactive,inboxEmpty:fresh.inboxEmpty};
      if (fresh.inboxIds.includes(inboxID)) await call("inbox.cancel",() => client.cancelInbox({sessionID:binding.sessionId,inboxID}));
    }
    if (!facts.inactive) {
      const fresh = await observe();
      // Queued IDs or an active flag alone cannot identify the active input. Already-terminal users do not identify new work either.
      if (fresh.whollyOwned && fresh.admissions.length === authorizedCount && fresh.prompts.length < authorizedCount && !fresh.inactive) {
        await call("session.interrupt",async () => { await client.interrupt({sessionID:binding.sessionId}); });
      }
    }
    if (!facts.inboxEmpty || !facts.inactive) facts = await observe();
    return {state:facts.terminal ? "terminal" : "pending",admissions:facts.admissions,prompts:facts.prompts,
      inboxEmpty:facts.inboxEmpty,inactive:facts.inactive};
  } catch (error) {
    if (error instanceof RunFenceError) throw error;
    if (error instanceof AgentBindingError) return {state:"ownership-conflict"};
    return {state:"pending",admissions:[],prompts:[],inboxEmpty:null,inactive:null};
  }
}
