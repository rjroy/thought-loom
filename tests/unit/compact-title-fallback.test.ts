import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { SpringboardThought } from "../../packages/contracts/src";
import ThoughtCard from "../../apps/web/app/ui/thought-card";

// Resolve the renderer from the web workspace that owns these dependencies.
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement }: typeof import("react") = requireWeb("react");
const { renderToStaticMarkup }: typeof import("react-dom/server") = requireWeb("react-dom/server");

const thought: SpringboardThought = { id: "fixture-item", sourceId: "fixture-root", kind: "interpretation", versionId: "fixture-current", author: "ai", createdAt: null, selection: "random", excerpt: "  One,\n  two\tTHREE four   five SIX seven." };
const render = (value: SpringboardThought) => renderToStaticMarkup(createElement(ThoughtCard, { thought: value }));

test("compact springboard card prefers a stored title to the represented excerpt", () => {
  const markup = render({ ...thought, title: { revisionId: "fixture-title", text: "Stored user label", author: "user" } });
  expect(markup).toContain("Stored user label");
  expect(markup).not.toContain("One,");
  expect(markup).toContain("AI interpretation");
  expect(markup).toContain("fixture-current");
});

for (const title of [undefined, { revisionId: "fixture-empty", text: "", author: "user" as const }]) {
  test(`compact springboard card uses five normalized excerpt words for ${title ? "empty" : "absent"} title`, () => {
    const markup = render({ ...thought, ...(title ? { title } : {}) });
    expect(markup).toContain("One, two THREE four five");
    expect(markup).not.toContain("SIX");
    expect(markup).toContain("AI interpretation");
    expect(markup).toContain("fixture-current");
  });
}

test("compact springboard fallback retains every word of a short body", () => {
  const markup = render({ ...thought, excerpt: "Short thought." });
  expect(markup).toContain("Short thought.");
  expect(markup).toContain("AI interpretation");
});
