"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { readImportSource, readSourceParts, readSourceRaw } from "../features/import/request";
import { readIdea } from "../features/idea/request";
import type { IdeaThought } from "../features/idea/types";
import type { ImportSource } from "../features/import/types";
import styles from "./import.module.css";

export function ImportInspection({ id, onClose, onThought }: { id: string; onClose: () => void; onThought: (thought: IdeaThought, source: ImportSource) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [source, setSource] = useState<ImportSource | null>(null), [original, setOriginal] = useState("");
  const [thought, setThought] = useState<IdeaThought | null>(null), [thoughtState, setThoughtState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const thoughtCallback = useRef(onThought); thoughtCallback.current = onThought;
  useEffect(() => {
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current!;
    element.showModal(); heading.current?.focus();
    return () => { element.close(); if (returnTarget?.isConnected && !returnTarget.matches(":disabled")) returnTarget.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const fetch: typeof window.fetch = (input, init) => window.fetch(input, { ...init, signal: controller.signal });
    const deps = { fetch, signal: controller.signal };
    setState("loading"); setThought(null); setThoughtState("loading");
    void (async () => {
      // Retained source/history reads occur only after this deliberate user inspection.
      const [metadata, raw, parts] = await Promise.all([readImportSource(id, deps), readSourceRaw(id, deps), readSourceParts(id, null, deps)]);
      if (controller.signal.aborted) return;
      if (metadata.kind === "unavailable" || raw.kind === "unavailable") { setState("unavailable"); setThoughtState("unavailable"); return; }
      if (metadata.kind !== "found" || raw.kind !== "found") { setState("error"); setThoughtState("error"); return; }
      setSource(metadata.value.source); setOriginal(new TextDecoder("utf-8").decode(raw.value)); setState("ready");
      if (parts.kind !== "found") { setThoughtState(parts.kind === "error" ? "error" : "unavailable"); return; }
      const candidate = parts.value.items.find(part => part.kind === "thought" && part.thoughtId && part.rejected !== true);
      if (!candidate?.thoughtId) { setThoughtState("unavailable"); return; }
      // History can identify the mapping, but never grants ordinary Idea eligibility.
      const normal = await readIdea(candidate.thoughtId, { part: "view", scope: "normal" }, deps);
      if (controller.signal.aborted) return;
      if (normal.kind === "view" && normal.value.thought.rejected !== true) {
        setThought(normal.value.thought); setThoughtState("ready"); thoughtCallback.current(normal.value.thought, metadata.value.source);
      } else setThoughtState(normal.kind === "error" ? "error" : "unavailable");
    })();
    return () => controller.abort();
  }, [id, revision]);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="import-original-heading" onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className={styles.actions}>
      <h2 id="import-original-heading" ref={heading} tabIndex={-1}>Inspect original</h2>
      <button type="button" className={styles.action} onClick={onClose}>Close</button>
    </div>
    <p className={styles.small}>User inspection · Original authorship unverified. This retained source is not additional AI context.</p>
    {state === "loading" && <p role="status">Loading the retained original…</p>}
    {state === "unavailable" && <p role="status">This original is unavailable.</p>}
    {state === "error" && <div className={styles.warning} role="status"><p>Could not read the original. No source has been changed.</p><button type="button" className={styles.action} onClick={() => setRevision(value => value + 1)}>Check original</button></div>}
    {state === "ready" && <>
      <h3 className={styles.sourcePath}>{source?.originalPath}</h3>
      {original ? <pre className={styles.original}>{original}</pre> : <p className={styles.small}>The retained original contains no text.</p>}
      {source?.thoughtCount === 0 && <p>0 thoughts — original retained.</p>}
      {thought && <Link className={styles.action} href={`/ideas/${encodeURIComponent(thought.id)}`} prefetch={false}>Open idea</Link>}
      {thoughtState === "error" && <p className={styles.small}>Could not check the mapped thought’s normal availability. No Idea link is inferred from this original.</p>}
      {thoughtState === "unavailable" && source?.thoughtCount !== 0 && <p className={styles.small}>No eligible mapped thought is available in this part of the source. Original inspection does not broaden Idea access.</p>}
    </>}
  </dialog>;
}
