"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { createAgenticSearchController, type AgenticSearchController } from "../features/agentic-search/controller";

const AgenticSearchContext = createContext<AgenticSearchController | null>(null);
export function AgenticSearchProvider({children}: {readonly children: ReactNode}) {
  const store = useRef<AgenticSearchController | null>(null);
  if (store.current === null) store.current = createAgenticSearchController();
  return <AgenticSearchContext.Provider value={store.current}>{children}</AgenticSearchContext.Provider>;
}
export function useAgenticSearchController(): AgenticSearchController {
  const store = useContext(AgenticSearchContext);
  if (!store) throw new Error("Agentic search requires its workspace provider.");
  return store;
}
