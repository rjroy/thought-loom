"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseSpringboardView, type SpringboardThought } from "@thoughtloom/contracts";
import ThoughtCard from "./thought-card";

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
    {batch.kind === "ready" && <div className="thought-cards">{batch.items.map((thought) => <ThoughtCard key={`${thought.kind === "source" ? "source" : "item"}-${thought.id}`} thought={thought} />)}</div>}
  </section>;
}
