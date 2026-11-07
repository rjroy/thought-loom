"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Guard existing shell elements without adding a sticky-position containing box. */
export function RootSplashShell({ children }: { children: ReactNode }) {
  const root = usePathname() === "/";
  const guard = { "data-root-arrival": root ? "true" : undefined, inert: root, "aria-hidden": root ? true : undefined };
  return <>
    <a {...guard} className="skip-link root-splash-shell" href="#main-content">Skip to content</a>
    <header {...guard} className="site-header root-splash-shell">{children}</header>
  </>;
}
