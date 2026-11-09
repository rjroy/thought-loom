"use client";

import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";
import type { BrowseController } from "../features/browse/controller";
import type { BrowseMapController } from "../features/browse/map-controller";
import type { MapPoint } from "../features/browse/map-layout";

export interface BrowseMemory {
  readonly controller: BrowseController;
  url: string;
  scrollY: number;
}

const BrowseContext = createContext<RefObject<BrowseMemory | null> | null>(null);
export interface BrowseMapMemory {
  readonly controller: BrowseMapController;
  framedRoot: MapPoint | null;
}
const BrowseMapContext = createContext<RefObject<BrowseMapMemory | null> | null>(null);

/** One document's reading workspace. Reload deliberately starts a fresh live catalog walk. */
export function BrowseProvider({ children }: { children: ReactNode }) {
  const memory = useRef<BrowseMemory | null>(null);
  const map = useRef<BrowseMapMemory | null>(null);
  return <BrowseContext.Provider value={memory}><BrowseMapContext.Provider value={map}>{children}</BrowseMapContext.Provider></BrowseContext.Provider>;
}

export function useBrowseMapMemory() {
  const memory = useContext(BrowseMapContext);
  if (!memory) throw new Error("Browse map requires its workspace provider.");
  return memory;
}

export function useBrowseMemory() {
  const memory = useContext(BrowseContext);
  if (!memory) throw new Error("Browse requires its workspace provider.");
  return memory;
}
