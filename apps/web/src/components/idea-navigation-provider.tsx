"use client";

import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";

export interface PreviousIdea {
  readonly href: string;
  readonly title: string;
}
interface IdeaNavigation extends PreviousIdea {
  readonly destination: string;
}

const NavigationContext = createContext<RefObject<IdeaNavigation | null> | null>(null);

/** One pending, deliberate Idea-link navigation in this mounted browser only. */
export function IdeaNavigationProvider({ children }: { children: ReactNode }) {
  const navigation = useRef<IdeaNavigation | null>(null);
  return <NavigationContext.Provider value={navigation}>{children}</NavigationContext.Provider>;
}

export function useIdeaNavigation() {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("Idea navigation requires its browser provider.");
  return navigation;
}
