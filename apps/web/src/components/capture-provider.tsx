"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import type { CaptureResult, CaptureSnapshot } from "../features/capture/submission";

export type CaptureState = { kind: "editing" } | { kind: "saving"; snapshot: CaptureSnapshot } | CaptureResult;
export interface CaptureDraft { text: string; title: string; state: CaptureState; validation: string | null; }
const CaptureContext = createContext<{ current: CaptureDraft | null } | null>(null);

/** A mounted return from Import retains the complete draft, including an uncertain receipt. */
export function CaptureProvider({ children }: { children: ReactNode }) {
  const memory = useRef<CaptureDraft | null>(null);
  return <CaptureContext.Provider value={memory}>{children}</CaptureContext.Provider>;
}

export function useCaptureMemory() {
  const memory = useContext(CaptureContext);
  if (!memory) throw new Error("Capture requires its mounted draft provider.");
  return memory;
}
