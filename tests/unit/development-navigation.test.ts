import { afterEach, expect, test } from "bun:test";
import { revealInquiryAnchor } from "../../apps/web/app/ui/development-navigation";

const saved = new Map(["document", "requestAnimationFrame", "HTMLDetailsElement"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function fixture(initiallyMounted = true) {
  const frames: FrameRequestCallback[] = [], calls: string[] = [];
  const body = { nodeName: "BODY", isConnected: true }, summary = { nodeName: "SUMMARY", isConnected: true };
  let active: object = body;
  let mounted = initiallyMounted;
  const element = { parentElement: null, isConnected: true, scrollIntoView() { calls.push("scroll-target"); }, focus() { calls.push("focus-target"); active = element; } };
  let visible = element;
  Object.defineProperty(globalThis, "HTMLDetailsElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body, getElementById: (id: string) => id === "discussion-target" && mounted ? visible : null, get activeElement() { return active; } } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; } });
  return { calls, target: element, summary, active: () => active, userFocus: () => { active = summary; }, removeTrigger: () => { summary.isConnected = false; active = body; }, mount: () => { mounted = true; }, replace: () => { element.isConnected = false; visible = { ...element, isConnected: true }; }, pending: () => frames.length, frame: () => { const callback = frames.shift(); if (!callback) throw new Error("Missing animation frame"); callback(0); } };
}

test("CAPTURE-FOCUS-01 normal anchor navigation focuses and scrolls target", () => {
  const f = fixture(); revealInquiryAnchor("discussion-target"); f.frame(); f.frame();
  expect(f.active()).toBe(f.target); expect(f.calls).toEqual(["scroll-target", "focus-target"]);
});

test("CAPTURE-FOCUS-01 user focus between frames is not stolen or scrolled", () => {
  const f = fixture(); revealInquiryAnchor("discussion-target"); f.frame(); f.userFocus(); f.frame();
  expect(f.active()).toBe(f.summary); expect(f.calls).toEqual([]);
});

test("CAPTURE-FOCUS-01 navigation focuses a target mounted after scheduling", () => {
  const f = fixture(false); revealInquiryAnchor("discussion-target");
  expect(f.pending()).toBe(1);
  f.frame(); f.mount(); f.frame();
  expect(f.active()).toBe(f.target); expect(f.calls).toEqual(["scroll-target", "focus-target"]);
});

test("CAPTURE-FOCUS-01 missing target stops after two frames", () => {
  const f = fixture(false); revealInquiryAnchor("discussion-target"); f.frame(); f.frame();
  expect(f.pending()).toBe(0); expect(f.calls).toEqual([]);
});

test("CAPTURE-FOCUS-01 an observed target replacement is not chased", () => {
  const f = fixture(); revealInquiryAnchor("discussion-target"); f.frame(); f.replace(); f.frame();
  expect(f.calls).toEqual([]);
});

test("CAPTURE-FOCUS-01 removed navigation trigger may release focus to body", () => {
  const f = fixture(); f.userFocus(); revealInquiryAnchor("discussion-target"); f.frame(); f.removeTrigger(); f.frame();
  expect(f.active()).toBe(f.target); expect(f.calls).toEqual(["scroll-target", "focus-target"]);
});

test("CAPTURE-FOCUS-01 newer intent prevents older navigation focus", () => {
  const f = fixture(); revealInquiryAnchor("discussion-target"); revealInquiryAnchor("missing-target");
  f.frame(); f.frame(); f.frame(); expect(f.calls).toEqual([]);
});

test("CAPTURE-FOCUS-01 pre-await owner and intent prevent focus theft after user navigation", () => {
  const f = fixture(); const owner = document.activeElement; f.userFocus();
  revealInquiryAnchor("discussion-target", { owner, isCurrent: () => true }); f.frame();
  expect(f.active()).toBe(f.summary); expect(f.calls).toEqual([]);
  revealInquiryAnchor("discussion-target", { owner: document.activeElement, isCurrent: () => false }); f.frame();
  expect(f.active()).toBe(f.summary); expect(f.calls).toEqual([]);
});
