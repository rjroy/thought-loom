"use client";

import { createContext, useContext } from "react";
import type { ItemView } from "@thoughtloom/contracts";

export const DevelopmentNavigation = createContext<{ root: string; openItem: (item: ItemView) => void; openDiscussion: (id: string, turnId: string) => void } | null>(null);
export const useDevelopmentNavigation = () => useContext(DevelopmentNavigation);

export function revealInquiryAnchor(id: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const element = document.getElementById(id); if (!element) return;
    let ancestor = element.parentElement;
    while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
    element.scrollIntoView({ block: "start" }); element.focus({ preventScroll: true });
  }));
}
