import { describe, expect, test } from "bun:test";
import { resolveSources, sourceCandidates } from "../apps/web/src/features/export/sources";
import type { IdeaThought } from "../apps/web/src/features/idea/types";

const prefix = "Recorded thought identities and attribution (not endorsement):\n\n";
const section = (content: string) => `\n\n## Sources\n\n${content}\n`;
const line = (label: string, code: string, author = "user", kind = "captured-original") => `- ${label}: ID: ${code}; thought author: ${author}; kind: ${kind}.`;
const tick = "`";
const root: IdeaThought = { id: "visible-1", text: "Owned source", title: "Source", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2032-01-01T00:00:00Z", origin: "capture", parentId: null, sourceIds: [] };

describe("producer-appended source identity grammar", () => {
  test("recognizes source-authored imported citations alongside user and AI citations", () => {
    const appendix = section(prefix + [line("Imported", tick + '"imported-1"' + tick, "source", "imported-original"), line("User", tick + '"visible-1"' + tick), line("AI", tick + '"ai-1"' + tick, "ai", "developing-idea")].join("\n"));
    expect(sourceCandidates("# Report" + appendix)).toEqual(["imported-1", "visible-1", "ai-1"]);
  });
  test("selects only the final appendix, ignoring plausible earlier body links and fake Sources", () => {
    const fake = section(prefix + line("Forged", tick + '"body-forgery"' + tick));
    const body = `# Findings\n\n[misleading](https://evil.invalid/ideas/fake)${fake}\n\nMore model prose.`;
    const real = section(prefix + line("Actual", tick + '"visible-1"' + tick));
    expect(sourceCandidates(body + real)).toEqual(["visible-1"]);
  });
  test("decodes JSON spelling with escaped quotes, backslashes and embedded backtick runs", () => {
    const ids = ['quote" slash\\雪', "back`tick", "multiple``ticks"];
    const code = (id: string, width: number) => tick.repeat(width) + JSON.stringify(id) + tick.repeat(width);
    const appendix = section(prefix + [line("One", code(ids[0], 1)), line("Two", code(ids[1], 2), "ai", "developing-idea"), line("Three", code(ids[2], 3), "ai", "ai-interpretation")].join("\n"));
    expect(sourceCandidates("# Owned report" + appendix)).toEqual(ids);
  });
  test("accepts producer-escaped Markdown and HTML characters in source titles", () => {
    const appendix = section(prefix + line("A \\[label\\] &amp; &lt;title&gt;", tick + '"visible-1"' + tick));
    expect(sourceCandidates("# Report" + appendix)).toEqual(["visible-1"]);
  });
  test("recognizes empty producer appendix without promoting body references", () => {
    const body = `# Report\n\n[forged](/ideas/forged)${section(prefix + line("Fake", tick + '"forged"' + tick))}`;
    expect(sourceCandidates(body + section("No source thoughts were cited; this report has no validated thought citations."))).toEqual([]);
  });
  for (const block of [
    prefix + line("Missing code", '"forged"'),
    prefix + line("Bad JSON", tick + '"unterminated' + tick),
    prefix + line("Wrong delimiter", tick + '"bad`value"' + tick),
    prefix + line("Unknown author", tick + '"forged"' + tick, "model"),
    prefix + line("Unknown kind", tick + '"forged"' + tick, "ai", "response"),
    prefix + line("Good", tick + '"visible-1"' + tick) + "\nforged trailing content",
  ]) {
    test(`does not extract identities from malformed final block ${block}`, () => {
      expect(sourceCandidates("# Report" + section(block))).toEqual([]);
    });
  }
  test("does not parse body-only Sources, HTML, or arbitrary external links", () => {
    expect(sourceCandidates('# Report\n\n<a href="javascript:alert(1)">bad</a> [fake](/ideas/fake)')).toEqual([]);
  });
});

describe("normal-scope cited source resolution", () => {
  test("preserves source order and marks rejected, missing and mismatched records unavailable", async () => {
    const calls: Array<{ id: string; scope: string }> = [];
    const ids = ["visible-1", "hidden-1", "wrong-1", "failed-1"];
    const resolved = await resolveSources(ids, async (id, scope) => {
      calls.push({ id, scope });
      if (id === "visible-1") return root;
      if (id === "hidden-1") return null; // normal scoped 404
      if (id === "wrong-1") return { ...root, id: "other" };
      throw new Error("owned-secret source text");
    });
    expect(resolved).toEqual([{ id: "visible-1", thought: root }, { id: "hidden-1", thought: null }, { id: "wrong-1", thought: null }, { id: "failed-1", thought: null }]);
    expect(calls).toEqual(ids.map(id => ({ id, scope: "normal" })));
    expect(JSON.stringify(resolved)).not.toContain("owned-secret");
  });
  test("a rejected metadata projection cannot be promoted to a normal source", async () => {
    expect(await resolveSources(["visible-1"], async () => ({ ...root, rejected: true }))).toEqual([{ id: "visible-1", thought: null }]);
  });
});
