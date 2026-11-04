"use client";

import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";
import type { DatePreset, SearchQuery } from "../features/explore/query";
import type { WebSearchPage } from "../features/explore/results";

export interface ExploreState {
  query: SearchQuery;
  draft: string;
  dateChoice: DatePreset | "custom";
  phase: "initial" | "loading" | "success" | "error";
  page: WebSearchPage | null;
  message: string | null;
  validation: "query" | "dates" | "link" | null;
  expanded: readonly string[];
}

interface ExploreMemory {
  state: ExploreState;
  url: string;
  scrollY: number;
}

const ExploreContext = createContext<RefObject<ExploreMemory | null> | null>(null);

/** One mounted browser workspace, never shared server state or persistent storage. */
export function ExploreProvider({ children }: { children: ReactNode }) {
  const memory = useRef<ExploreMemory | null>(null);
  return <ExploreContext.Provider value={memory}>{children}</ExploreContext.Provider>;
}

export function useExploreMemory() {
  const memory = useContext(ExploreContext);
  if (!memory) throw new Error("Explore requires its workspace provider.");
  return memory;
}
