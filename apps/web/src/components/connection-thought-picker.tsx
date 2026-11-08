"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { fetchSearch } from "../features/explore/request";
import type { SearchResult } from "../features/explore/results";
import { readIdea } from "../features/idea/request";
import type { IdeaThought } from "../features/idea/types";
import { ContentGlyph } from "./content-glyph";
import idea from "./idea.module.css";
import styles from "./connection-editor.module.css";

export const connectionTitle = (thought: IdeaThought) => thought.title ?? thought.text.trim().split(/\s+/).slice(0, 5).join(" ");
const materials = {
  "captured-original": "Original capture", "user-contribution": "Contribution",
  "ai-interpretation": "Interpretation", "developing-idea": "Developing idea", "imported-original": "Imported source",
};
const actor = (author: string) => author === "user" ? "You" : author === "ai" ? "AI" : "Imported source";

export function ConnectionThought({ thought }: { thought: IdeaThought }) {
  const [expanded, setExpanded] = useState(false);
  const long = thought.text.length > 320;
  return <div className={styles.thought}>
    <strong>{connectionTitle(thought)}</strong>
    <p className={idea.byline}><span className={thought.author === "user" ? idea.user : idea.ai}>{actor(thought.author)}</span>
      <span className={idea.materialLabel}><ContentGlyph kind={thought.kind} size={20} />{materials[thought.kind]}</span></p>
    <p className={styles.words}>{long && !expanded ? `${thought.text.slice(0, 320)}…` : thought.text}</p>
    {long && <button type="button" className={idea.textButton} aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show full thought"}</button>}
  </div>;
}

/** Search hits are candidates; only a fresh normal-scope Idea read selects a thought. */
export function ConnectionThoughtPicker({ supporting = false, excluded, locked, onChoose, onQueryChange }: {
  supporting?: boolean; excluded: readonly string[]; locked: boolean;
  onChoose: (thought: IdeaThought) => void; onQueryChange: (value: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<"initial" | "loading" | "results" | "error">("initial");
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; thought: IdeaThought } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const alive = useRef(false);
  const queryInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    if (!supporting) queryInput.current?.focus();
    return () => { alive.current = false; generation.current++; request.current?.abort(); };
  }, [supporting]);
  useEffect(() => {
    if (locked) {
      generation.current++; request.current?.abort(); setReading(null); setPhase("initial"); setResults([]); setPreview(null);
    }
  }, [locked]);

  function editQuery(value: string) {
    generation.current++; request.current?.abort();
    setQuery(value); onQueryChange(value); setResults([]); setPreview(null); setReading(null); setMessage(null); setPhase("initial");
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    if (!query.trim()) { setMessage("Enter a few words to search."); queryInput.current?.focus(); return; }
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPhase("loading"); setResults([]); setPreview(null); setReading(null); setMessage(null);
    const result = await fetchSearch({ q: query, author: [], kind: [], sort: "relevance", scope: "normal" }, {
      fetch: window.fetch.bind(window), signal: controller.signal,
    });
    if (!alive.current || current !== generation.current || controller.signal.aborted) return;
    if (result.kind === "success") { setResults(result.page.results); setPhase("results"); }
    else { setPhase("error"); setMessage("Search unavailable. Your query is still here. Search again to retry this read."); }
  }
  async function readCandidate(result: SearchResult, choose: boolean) {
    if (locked) return;
    const current = ++generation.current, key = `${result.kind}:${result.id}`;
    request.current?.abort(); setReading(key); setMessage(null); setPreview(null);
    const read = await readIdea(result.thoughtId, { scope: "normal", part: "view" }, { fetch: window.fetch.bind(window) });
    if (!alive.current || current !== generation.current) return;
    setReading(null);
    if (read.kind !== "view" || read.value.thought.rejected === true) {
      setMessage("This thought is unavailable for selection. Try another result; your other inputs are unchanged."); return;
    }
    if (choose) {
      onChoose(read.value.thought); setResults([]); setPreview(null); setPhase("initial");
    } else setPreview({ key, thought: read.value.thought });
  }

  return <div className={styles.picker}>
    <form onSubmit={search} role="search" aria-label={supporting ? "Find supporting thoughts" : "Find another thought"} noValidate>
      <label htmlFor={id}>{supporting ? "Search supporting thoughts" : "Search thoughts"}</label>
      <div className={styles.searchRow}>
        <input id={id} ref={queryInput} type="text" value={query} readOnly={locked}
          aria-describedby={message ? `${id}-message` : undefined} onChange={event => editQuery(event.target.value)} />
        <button type="submit" className={idea.button} disabled={locked} aria-busy={phase === "loading"}>
          {supporting ? "Search supporting thoughts" : "Search"}</button>
      </div>
    </form>
    {message && <p id={`${id}-message`} className={idea.error} role="status">{message}</p>}
    {phase === "loading" && <p role="status">Searching thoughts…</p>}
    {phase === "results" && results.filter(result => !excluded.includes(result.thoughtId)).length === 0 && <p role="status">No results available for selection. Try another query.</p>}
    <div className={styles.results}>
      {results.filter(result => !excluded.includes(result.thoughtId)).map(result => {
        const key = `${result.kind}:${result.id}`;
        return <article key={key} className={styles.result}>
          <h4>{result.title}</h4>
          <p className={idea.metadata}>{actor(result.author)} · {result.kind === "response" ? "Full reply · " : ""}{materials[result.materialKind]}</p>
          <p className={styles.words}>{result.snippet}</p>
          {result.kind === "response" && <p className={idea.metadata}>Choose its associated thought, not the full reply as a separate endpoint.</p>}
          {preview?.key === key && <div className={styles.preview}><ConnectionThought thought={preview.thought} /></div>}
          <div className={styles.resultActions}>
            <button type="button" className={idea.textButton} disabled={locked || reading === key}
              aria-expanded={preview?.key === key} onClick={() => void readCandidate(result, false)}>Preview thought</button>
            <button type="button" className={idea.textButton} disabled={locked || reading === key}
              onClick={() => void readCandidate(result, true)}>{supporting ? "Add supporting thought" : "Choose this thought"}</button>
            {reading === key && <span role="status">Reading thought…</span>}
          </div>
        </article>;
      })}
    </div>
  </div>;
}
