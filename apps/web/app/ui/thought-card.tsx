"use client";

import { useId, useState } from "react";
import Link from "next/link";
import type { SpringboardThought } from "@thoughtloom/contracts";
import { inquiryHref } from "../../lib/links";

export default function ThoughtCard({ thought }: { thought: SpringboardThought }) {
  const [focused, setFocused] = useState(false), [hovered, setHovered] = useState(false), [dismissed, setDismissed] = useState(false);
  const id = useId(), anchor = `--thought-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const original = thought.kind === "source", label = thought.title?.text ?? thought.excerpt;
  const role = original ? "original" : thought.author === "user" ? "user" : thought.kind === "developing-idea" ? "idea" : "ai";
  const attribution = original ? "Original" : thought.author === "user" ? "Your formulation" : thought.kind === "interpretation" ? "AI interpretation · Tentative" : "AI developing idea · Tentative";
  const href = original ? `${inquiryHref(thought.sourceId)}#discussion-target` : inquiryHref(thought.sourceId, "", thought.id, thought.versionId);
  const reveal = !!thought.title && !dismissed && (focused || hovered);
  return <div className="thought-card-wrap" onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)} onKeyDown={(event) => { if (event.key === "Escape") { setDismissed(true); event.stopPropagation(); } }}>
    <Link className="thought-card" href={href} prefetch={false} data-role={role} style={{ anchorName: anchor }}
      aria-describedby={reveal ? id : undefined} onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}>
      <span className="thought-card-excerpt">{label}</span>
      <span className="thought-card-meta"><span>{attribution}</span><span>{thought.selection === "recent" ? "Recent" : "Random"}</span></span>
    </Link>
    {thought.title && <span id={id} className="thought-title-tooltip" role="tooltip" hidden={!reveal} style={{ positionAnchor: anchor }}>{label}</span>}
  </div>;
}
