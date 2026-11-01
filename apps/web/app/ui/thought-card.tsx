"use client";

import { useId, useState } from "react";
import Link from "next/link";
import type { SpringboardThought } from "@thoughtloom/contracts";
import { inquiryHref } from "../../lib/links";
import { compactThoughtLabel } from "../../lib/thought-label";
import { ThoughtTextDisclosure } from "./text-disclosure";
import type { ThoughtTextTarget } from "../../lib/thought-text-client";

export default function ThoughtCard({ thought }: { thought: SpringboardThought }) {
  const [focused, setFocused] = useState(false), [hovered, setHovered] = useState(false), [dismissed, setDismissed] = useState(false);
  const id = useId(), anchor = `--thought-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const original = thought.kind === "source", label = compactThoughtLabel(thought.title?.text, thought.excerpt);
  const role = original ? "original" : thought.author === "user" ? "user" : thought.kind === "developing-idea" ? "idea" : "ai";
  const attribution = original ? "Original" : thought.author === "user" ? "Your formulation" : thought.kind === "interpretation" ? "AI interpretation · Tentative" : "AI developing idea · Tentative";
  const href = original ? `${inquiryHref(thought.sourceId)}#discussion-target` : inquiryHref(thought.sourceId, "", thought.id, thought.versionId);
  const storedTitle = !!thought.title?.text.trim();
  const reveal = storedTitle && !dismissed && (focused || hovered);
  const target: ThoughtTextTarget | undefined = original ? { kind: "source", sourceId: thought.sourceId }
    : thought.versionId ? { kind: "item", sourceId: thought.sourceId, itemId: thought.id, versionId: thought.versionId } : undefined;
  return <div className="thought-card-wrap" data-role={role} onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)} onKeyDown={(event) => { if (event.key === "Escape") { setDismissed(true); event.stopPropagation(); } }}>
    <Link className="thought-card" href={href} prefetch={false} data-role={role} style={{ anchorName: anchor }}
      aria-describedby={reveal ? id : undefined} onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}>
      <span className="thought-card-excerpt">{label}</span>
      <span className="thought-card-meta"><span>{attribution}</span><span>{thought.selection === "recent" ? "Recent" : "Random"}</span></span>
    </Link>
    {target && <ThoughtTextDisclosure target={target} />}
    {storedTitle && <span id={id} className="thought-title-tooltip" role="tooltip" hidden={!reveal} style={{ positionAnchor: anchor }}>{label}</span>}
  </div>;
}
