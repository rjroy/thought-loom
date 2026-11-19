"use client";

import Link from "next/link";
import { useState } from "react";
import type { IdeaThought } from "../features/idea/types";
import { ContentGlyph } from "./content-glyph";
import styles from "./evolve.module.css";
import { MediaSourceDetails } from "./media-source-details";
import { ThoughtMarkdown } from "./thought-markdown";

export const wordsTitle = (words: string) => words.trim().split(/\s+/).slice(0, 5).join(" ");
export const titleOf = (thought: IdeaThought) => thought.title ?? (thought.kind === "media-original" ? thought.mediaSource.name : wordsTitle(thought.text));
export const hrefOf = (id: string) => `/ideas/${encodeURIComponent(id)}`;
const kinds = {
  "captured-original": "Original capture", "user-contribution": "Contribution",
  "ai-interpretation": "Interpretation", "developing-idea": "Developing idea", "imported-original": "Imported source", "media-original": "Image or PDF",
};

export function Byline({ thought }: { thought: IdeaThought }) {
  return <p className={styles.byline}><span className={thought.author === "user" ? styles.user : thought.author === "ai" ? styles.ai : styles.source}>{thought.author === "user" ? "You" : thought.author === "ai" ? "AI" : "Imported source"}</span> · <span className={styles.materialLabel}><ContentGlyph kind={thought.kind === "media-original" ? "imported-original" : thought.kind} size={20} />{kinds[thought.kind]}</span></p>;
}

export function StartingThought({ thought, loading, onInspect }: { thought: IdeaThought | null; loading: boolean; onInspect?: () => void }) {
  const [open, setOpen] = useState(false);
  return <div className={styles.context}>
    <button className={styles.contextToggle} type="button" aria-expanded={open}
      aria-controls="evolve-starting-context" onClick={() => setOpen(!open)}>
      <span>Starting thought{thought ? ` · ${titleOf(thought)}` : ""}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
    </button>
    <aside className={styles.rail} id="evolve-starting-context" data-open={open} aria-labelledby="evolve-starting-heading">
      <h2 id="evolve-starting-heading">Starting thought</h2>
      {loading ? <p role="status">Reading the starting thought…</p>
        : thought ? <>
          <h3>{titleOf(thought)}</h3><Byline thought={thought} />
          {thought.kind === "media-original" ? <MediaSourceDetails source={thought.mediaSource} compact /> : <ThoughtMarkdown className={styles.savedText} text={thought.text} headingLevel={4} />}
          <Link href={hrefOf(thought.id)} prefetch={false} onNavigate={onInspect}>Open idea</Link>
        </> : <><p>Starting thought unavailable.</p><p className={styles.muted}>No history scope will be opened automatically.</p></>}
    </aside>
  </div>;
}
