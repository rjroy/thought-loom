import { expect, test } from "bun:test";
import { parseThoughtTitle, type ThoughtTitle } from "../../packages/contracts/src";
import { TitleState } from "../../apps/web/lib/title-state";
import type { TitleTarget, TitleView } from "../../apps/web/lib/title-client";

const old: TitleTarget = { kind: "item", itemId: "fixture-item", versionId: "version-old" };
const current: TitleTarget = { kind: "item", itemId: "fixture-item", versionId: "version-current" };
const source: TitleTarget = { kind: "source" };
function title(revisionId: string, author: "user" | "ai", text: string): ThoughtTitle {
  const value = parseThoughtTitle({ revisionId, author, text });
  if (!value) throw new Error("Invalid test-owned title"); return value;
}
const ai = title("ai-current", "ai", "Current AI title"), user1 = title("user-one", "user", "First user title"), user2 = title("user-two", "user", "Second user title");
function view(headRevisionId: string | null, value: ThoughtTitle | null): TitleView { return { headRevisionId, title: value }; }

test("cached generated and null versions yield to newer inquiry USER metadata without inventing a head", () => {
  const state = new TitleState([{ target: current, title: ai }, { target: old, title: null }]);
  const read = state.begin(current); expect(state.accept(read, { target: current, title: ai }, view(ai.revisionId, ai))).toBe(true);
  const inquiry = state.begin(); expect(state.accept(inquiry, { target: current, title: user2 })).toBe(true);
  expect(state.display(current)).toEqual(user2); expect(state.display(old)).toEqual(user2); expect(state.head(current)).toBeUndefined();
});

test("older unsequenced props cannot roll back an accepted newer user title", () => {
  const state = new TitleState([{ target: current, title: user1 }]);
  const next = state.begin(); expect(state.accept(next, { target: current, title: user2 })).toBe(true);
  state.seed({ target: current, title: user1 });
  expect(state.display(current)).toEqual(user2); expect(state.display(old)).toEqual(user2);
});

test("later inquiry wins over a held older dedicated GET", () => {
  const state = new TitleState([{ target: source, title: user1 }]);
  const held = state.begin(source), inquiry = state.begin();
  expect(state.accept(inquiry, { target: source, title: user2 })).toBe(true);
  expect(state.accept(held, { target: source, title: user1 }, view(user1.revisionId, user1))).toBe(false);
  expect(state.display(source)).toEqual(user2); expect(state.head(source)).toBeUndefined();
});

test("later dedicated GET wins over a held older inquiry", () => {
  const state = new TitleState([{ target: source, title: user1 }]);
  const held = state.begin(), read = state.begin(source);
  expect(state.accept(read, { target: source, title: user2 }, view(user2.revisionId, user2))).toBe(true);
  expect(state.accept(held, { target: source, title: user1 })).toBe(false);
  expect(state.display(source)).toEqual(user2); expect(state.head(source)).toBe(user2.revisionId);
});

test("one inquiry observation retains both current AI and historical null views", () => {
  const state = new TitleState(), observation = state.begin();
  expect(state.accept(observation, { target: current, title: ai })).toBe(true);
  expect(state.accept(observation, { target: old, title: null })).toBe(true);
  expect(state.display(current)).toEqual(ai); expect(state.display(old)).toBeUndefined(); expect(state.head(current)).toBeUndefined();
});

test("write barrier invalidates earlier observations and old acknowledgement is not a new read", () => {
  const state = new TitleState([{ target: source, title: user1 }]);
  const heldRead = state.begin(source), heldInquiry = state.begin();
  state.beginWrite(source);
  expect(state.accept(heldRead, { target: source, title: user1 }, view(user1.revisionId, user1))).toBe(false);
  expect(state.accept(heldInquiry, { target: source, title: user1 })).toBe(false);
  state.endWrite(source);
  const authoritative = state.begin(source); expect(state.accept(authoritative, { target: source, title: user2 }, view(user2.revisionId, user2))).toBe(true);
  expect(state.accept(heldRead, { target: source, title: user1 }, view(user1.revisionId, user1))).toBe(false);
  expect(state.display(source)).toEqual(user2); expect(state.head(source)).toBe(user2.revisionId);
});

test("separate root owners cannot share observations or same-key metadata", () => {
  const first = new TitleState([{ target: source, title: user1 }]), second = new TitleState([{ target: source, title: user2 }]);
  const token = first.begin(source);
  expect(second.accept(token, { target: source, title: user1 }, view(user1.revisionId, user1))).toBe(false);
  expect(first.display(source)).toEqual(user1); expect(second.display(source)).toEqual(user2);
});
