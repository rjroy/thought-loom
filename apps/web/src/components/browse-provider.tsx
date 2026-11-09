"use client";

import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";
import type { BrowseController } from "../features/browse/controller";

export interface BrowseMemory {
  readonly controller: BrowseController;
  url: string;
  scrollY: number;
}

const BrowseContext = createContext<RefObject<BrowseMemory | null> | null>(null);

/** One document's reading workspace. Reload deliberately starts a fresh live catalog walk. */
export function BrowseProvider({ children }: { children: ReactNode }) {
  const memory = useRef<BrowseMemory | null>(null);
  return <BrowseContext.Provider value={memory}>{children}</BrowseContext.Provider>;
}

export function useBrowseMemory() {
  const memory = useContext(BrowseContext);
  if (!memory) throw new Error("Browse requires its workspace provider.");
  return memory;
}
