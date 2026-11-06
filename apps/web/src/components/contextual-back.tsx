"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from "react";

interface BackTarget {
  readonly href: string;
  readonly label: string;
  readonly onNavigate?: () => void;
}
interface BackEntry extends BackTarget { readonly owner: symbol; readonly pathname: string; }
interface BackContextValue {
  readonly entry: BackEntry | null;
  readonly register: (pathname: string, target: BackTarget | null) => () => void;
}
const BackContext = createContext<BackContextValue | null>(null);

/** Only the mounted route publishes its existing return link, not a history stack. */
export function ContextualBackProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<BackEntry | null>(null);
  const register = useCallback((pathname: string, target: BackTarget | null) => {
    const owner = Symbol();
    setEntry(target ? { ...target, pathname, owner } : null);
    // An outgoing route must not clear a newer route's registration.
    return () => setEntry(current => current?.owner === owner ? null : current);
  }, []);
  return <BackContext.Provider value={{ entry, register }}>{children}</BackContext.Provider>;
}

export function useContextualBack(href: string | null, label: string, onNavigate?: () => void) {
  const context = useContext(BackContext), pathname = usePathname();
  if (!context) throw new Error("Contextual navigation requires its mounted provider.");
  const { register } = context;
  useEffect(() => register(pathname, href ? { href, label, onNavigate } : null), [register, pathname, href, label, onNavigate]);
}

export function ContextualBack() {
  const context = useContext(BackContext), pathname = usePathname(), tooltipId = useId();
  const [dismissed, setDismissed] = useState(false);
  if (!context) throw new Error("Contextual navigation requires its mounted provider.");
  const entry = context.entry;
  const contextualRoute = pathname.startsWith("/ideas/") || pathname === "/evolve" || pathname === "/export" || pathname === "/import"
    || pathname === "/explore/ask" || pathname.startsWith("/explore/ask/");
  if (!contextualRoute || !entry || entry.pathname !== pathname) return null;
  return <span className="contextual-back" data-dismissed={dismissed}
    onPointerEnter={() => setDismissed(false)} onFocus={() => setDismissed(false)}
    onKeyDown={event => { if (event.key === "Escape") setDismissed(true); }}>
    <Link className="contextual-back-link" href={entry.href} aria-label={entry.label}
      aria-describedby={tooltipId} prefetch={false} onNavigate={entry.onNavigate}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m10 5-7 7 7 7M3 12h18" />
      </svg>
    </Link>
    <span className="contextual-back-tooltip" id={tooltipId} role="tooltip">{entry.label}</span>
  </span>;
}
