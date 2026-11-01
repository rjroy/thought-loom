"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { parseSpringboardView, type SpringboardThought } from "@thoughtloom/contracts";
import { inquiryHref } from "../../lib/links";

type Batch = { kind: "loading" } | { kind: "ready"; items: SpringboardThought[] } | { kind: "unavailable" };

export default function RecentThoughts({ hidden }: { hidden: boolean }) {
  const [batch, setBatch] = useState<Batch>({ kind: "loading" });
  const request = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const ticket = ++request.current;
    setBatch({ kind: "loading" });
    console.info("springboard.read attempt");
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetch("/api/springboard", { cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const value = response.ok ? parseSpringboardView(await response.json()) : null;
      if (!value) throw new Error("Thoughts unavailable");
      if (signal?.aborted || ticket !== request.current) return;
      setBatch({ kind: "ready", items: value.items });
      console.info("springboard.read succeeded", { count: value.items.length });
    } catch {
      if (!signal?.aborted && ticket === request.current) {
        setBatch({ kind: "unavailable" }); console.warn("springboard.read unavailable");
      }
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    return () => { controller.abort(); request.current++; };
  }, [load]);

  if (batch.kind === "ready" && !batch.items.length) return null;
  return <section className="thought-springboard" aria-label="Thoughts" hidden={hidden} aria-busy={batch.kind === "loading"}>
    {batch.kind === "loading" && <p className="section-context" role="status">Loading thoughts…</p>}
    {batch.kind === "unavailable" && <div className="springboard-recovery"><p role="status">Thoughts unavailable.</p><button className="text-button" type="button" onClick={() => void load()}>Retry</button></div>}
    {batch.kind === "ready" && <div className="thought-cards">{batch.items.map((thought) => {
      const original = thought.kind === "source";
      const role = original ? "original" : thought.author === "user" ? "user" : thought.kind === "developing-idea" ? "idea" : "ai";
      const attribution = original ? "Original" : thought.author === "user" ? "Your formulation" : thought.kind === "interpretation" ? "AI interpretation · Tentative" : "AI developing idea · Tentative";
      const href = original ? `${inquiryHref(thought.sourceId)}#discussion-target` : inquiryHref(thought.sourceId, "", thought.id, thought.versionId);
      return <Link className="thought-card" href={href} prefetch={false} key={`${original ? "source" : "item"}-${thought.id}`} data-role={role} title={thought.excerpt}>
        <span className="thought-card-meta"><span>{attribution}</span><span>{thought.selection === "recent" ? "Recent" : "Random"}</span></span>
        <span className="thought-card-excerpt">{thought.excerpt}</span>
      </Link>;
    })}</div>}
  </section>;
}
