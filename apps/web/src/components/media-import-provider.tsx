"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { createMediaImportController } from "../features/media/controller";
import { createMediaClient, createMediaSourceClient } from "../features/media/request";
import { createMediaSourceController, type MediaSourceController } from "../features/media/source-controller";
import type { MediaScope, MediaSourceClient } from "../features/media/types";

type Controller = ReturnType<typeof createMediaImportController>;
interface MediaMemory { readonly imports: Controller; readonly sourceClient: MediaSourceClient; readonly sources: Map<string, MediaSourceController> }
const MediaImportContext = createContext<MediaMemory | null>(null);

/** Files and unresolved keys live only in this mounted document, never browser storage. */
export function MediaImportProvider({ children }: { children: ReactNode }) {
  const memory = useRef<MediaMemory | null>(null);
  if (!memory.current) {
    const browserFetch: typeof fetch = (input, init) => window.fetch(input, init);
    memory.current = { imports: createMediaImportController(createMediaClient(browserFetch)), sourceClient: createMediaSourceClient(browserFetch), sources: new Map() };
  }
  return <MediaImportContext.Provider value={memory.current}>{children}</MediaImportContext.Provider>;
}
export function useMediaImportController() {
  const memory = useContext(MediaImportContext);
  if (!memory) throw new Error("Media import requires its mounted provider.");
  return memory.imports;
}
export function useMediaSourceMemory() {
  const memory = useContext(MediaImportContext);
  if (!memory) throw new Error("Media sources require their mounted provider.");
  return memory;
}
export function sourceController(memory: MediaMemory, thoughtId: string, sourceId: string, scope: MediaScope) {
  const key = JSON.stringify([thoughtId, sourceId, scope]);
  let controller = memory.sources.get(key);
  if (!controller) { controller = createMediaSourceController({ thoughtId, sourceId, scope }, memory.sourceClient); memory.sources.set(key, controller); }
  return controller;
}
