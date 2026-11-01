"use client";

import { createContext, useContext } from "react";
import type { ItemView } from "@thoughtloom/contracts";

export const DevelopmentNavigation = createContext<{ root: string; openItem: (item: ItemView) => void; openDiscussion: (id: string, turnId: string) => void } | null>(null);
export const useDevelopmentNavigation = () => useContext(DevelopmentNavigation);

let revealIntent = 0;
export function revealInquiryAnchor(id: string, options: { owner?: Element | null; isCurrent?: () => boolean } = {}) {
  const intent = ++revealIntent, owner = options.owner === undefined ? document.activeElement : options.owner;
  let element = document.getElementById(id);
  function current() {
    if (intent !== revealIntent || options.isCurrent?.() === false) return false;
    if (document.activeElement !== owner && !(document.activeElement === document.body && owner && !owner.isConnected)) return false;
    const found = document.getElementById(id);
    if (element && (!element.isConnected || found !== element)) return false;
    element ??= found;
    return !element || element.isConnected;
  }
  requestAnimationFrame(() => {
    if (!current()) return;
    requestAnimationFrame(() => {
      // React may not have committed the target when navigation completed. Query
      // at both bounded frames, then pin any observed node rather than chasing it.
      if (!current() || !element) return;
      let ancestor = element.parentElement;
      while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
      element.scrollIntoView({ block: "start" }); element.focus({ preventScroll: true });
    });
  });
}
