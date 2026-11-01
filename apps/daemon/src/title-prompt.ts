import type { NativeRunProfile } from "./native-profile";

// Called only while creating a new immutable command, with its selected profile.
// Recovered commands retain their original text, even after capability changes.
export function titlePrompt(profile?: NativeRunProfile): string {
  if (!profile?.actions.includes("record_title_v1") || !profile.capability?.actions.includes("record_title_v1")) return "";
  return "Optional title metadata: if useful, use record_title_v1 within this same run's existing tool/time budget to add short, faithful titles (roughly six to ten words) to the owned root source or items created/revised in this work. No separate pass, extra session or corpus backfill; a missing title must not fail useful work. Never create a semantic interpretation, idea, alias or connection just to hold a title.\n" +
    "Stay within the granted root/target scope. Read the target with its granted read tool first; if that read is unavailable, skip title work. For items use the exact current formulation/version, not a pinned historical version, and reread after creating/revising an item. Preserve USER titles/labels: if titleState.title.author is user, leave that entity's label alone.\n" +
    "Pass rootSourceId, target ({kind: source} or {kind: item, itemId, versionId}), text and expectedTitleRevisionId = titleState.headRevisionId (null only when the read reports null). The effective title.revisionId is not the canonical head. On a title/version conflict, do not blindly retry or retarget; reread only if the existing budget permits, otherwise skip. Title metadata never replaces original/formulation text, evidence or authorship.\n";
}
