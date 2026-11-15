import { expect, test } from "bun:test";
import { initialWorkerPrompt } from "../src/agent/worker-prompts";
import { mediaThought } from "./fixtures/media-source";
import { mediaPathFixture } from "./fixtures/media-path-worker";
import { mediaNeighbor, mediaWeaveFixture, prepareMediaRun, startMediaTitleClear } from "./fixtures/media-weave";

test.each(["capture", "evolve", "media regeneration"] as const)(
  "%s cannot complete successfully while its subject has no title", kind => mediaWeaveFixture(f => {
    const prepared = kind === "media regeneration" ? startMediaTitleClear(f) : kind === "capture"
      ? prepareMediaRun(f, f.ops.admitWeave("user", { subjectId: mediaNeighbor.id, triggerId: "capture:required-title" }))
      : prepareMediaRun(f, f.admissions.admit("user", "evolve", { parentId: mediaNeighbor.id, text: "An untitled contribution" }).run);
    const subjectId = kind === "media regeneration" ? mediaThought.id : kind === "capture" ? mediaNeighbor.id
      : prepared.context.job.kind === "evolve" ? prepared.context.job.contributionId : (() => { throw new Error("Expected Evolve context"); })();
    expect(f.store.getThought(subjectId)?.title).toBeNull();
    f.steps.completeStep(prepared.claim, prepared.step.promptId, { version: 1, kind: "complete", reply: "No title was generated" });
    try { f.state.finish(prepared.claim, prepared.step.promptId); } catch { /* Refusal or failure are both non-success. */ }
    expect(f.runs.get(prepared.run.id)?.status).not.toBe("completed");
    expect(f.store.getThought(subjectId)?.title).toBeNull();
    expect(f.runs.reply(prepared.run.id)?.state).not.toBe("complete");
  }),
);

test("initial media capture prompt requires a title as well as source interpretation", async () => mediaPathFixture(async f => {
  const prompt = initialWorkerPrompt({ job: { kind: "weave", subjectId: f.source.id, purpose: "ordinary" },
    thoughts: [f.source], connections: [], responses: [] });
  const rendered = JSON.parse(prompt) as { role: string; instructions: string[] };
  const guidance = [rendered.role, ...rendered.instructions].join(" ");
  expect(guidance).toMatch(/(?:must|required|always)[^.]*title|title[^.]*(?:must|required)/i);
  expect(guidance).toMatch(/interpretation/i);
}, null));

test("a concurrent user title satisfies regeneration without being overwritten", () => mediaWeaveFixture(f => {
  const prepared = startMediaTitleClear(f);
  f.titles.setUser("user", mediaThought.id, "A user title");
  f.steps.completeStep(prepared.claim, prepared.step.promptId, { version: 1, kind: "complete", reply: "Title already supplied" });
  f.state.finish(prepared.claim, prepared.step.promptId);
  expect(f.runs.get(prepared.run.id)?.status).toBe("completed");
  expect(f.store.getThought(mediaThought.id)).toMatchObject({ title: "A user title", titleAuthor: "user" });
}));

test.each(["capture", "evolve", "media regeneration"] as const)(
  "%s prompt requires an absent title rather than making it optional", kind => mediaWeaveFixture(f => {
    const prepared = kind === "media regeneration" ? startMediaTitleClear(f) : kind === "capture"
      ? prepareMediaRun(f, f.ops.admitWeave("user", { subjectId: mediaNeighbor.id, triggerId: "capture:required-title-prompt" }))
      : prepareMediaRun(f, f.admissions.admit("user", "evolve", { parentId: mediaNeighbor.id, text: "An untitled contribution" }).run);
    const rendered = JSON.parse(prepared.input) as { role: string; instructions: string[] };
    const guidance = [rendered.role, ...rendered.instructions].join(" ");
    expect(guidance).toMatch(/(?:must|required|always)[^.]*title|title[^.]*(?:must|required)/i);
    expect(guidance).not.toMatch(/(?:title[^.]*when warranted|no title fill is warranted)/i);
  }),
);
