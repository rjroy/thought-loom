"use client";

import { useEffect, useId, useRef, useState, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { readThoughtText, thoughtTextIdentity, type ThoughtTextTarget } from "../../lib/thought-text-client";

function DisclosureButton({ expanded, controls, onClick, retry = false, buttonRef }: { expanded: boolean; controls: string; onClick: MouseEventHandler<HTMLButtonElement>; retry?: boolean; buttonRef?: Ref<HTMLButtonElement> }) {
  return <button ref={buttonRef} type="button" className="text-button text-disclosure-toggle" aria-expanded={expanded} aria-controls={controls} onClick={onClick}>{retry ? "Retry full text" : expanded ? "Show less" : "Read full text"}</button>;
}

export default function CompactText({ identity, text, className = "" }: { identity: string; text: string; className?: string }) {
  return <LoadedText key={identity} text={text} className={className} />;
}

function LoadedText({ text, className }: { text: string; className: string }) {
  const [expanded, setExpanded] = useState(false), [clipped, setClipped] = useState(false);
  const body = useRef<HTMLParagraphElement>(null), id = useId();
  useEffect(() => {
    const node = body.current;
    if (!node || expanded) return;
    let current = true;
    // Once offered, keep the control for this version: a resize must not remove
    // the button that the reader is using to collapse the text.
    const measure = () => { if (current && node.scrollHeight > node.clientHeight + 1) setClipped(true); };
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure(); void document.fonts.ready.then(measure);
    return () => { current = false; observer.disconnect(); };
  }, [text, expanded]);
  return <><p ref={body} id={id} className={`thought-body ${className}`} data-text-expanded={expanded}>{text}</p>{(clipped || expanded) && <DisclosureButton expanded={expanded} controls={id} onClick={() => setExpanded((value) => !value)} />}</>;
}

type TextPreview = { collapsed: ReactNode; expanded?: ReactNode };

export function ThoughtTextDisclosure({ target, preview }: { target: ThoughtTextTarget; preview?: TextPreview }) {
  return <LazyText key={thoughtTextIdentity(target)} target={target} preview={preview} />;
}

type ReadState = { kind: "idle" | "loading" | "unavailable" } | { kind: "ready"; text: string };

function LazyText({ target, preview }: { target: ThoughtTextTarget; preview?: TextPreview }) {
  const [expanded, setExpanded] = useState(false), [read, setRead] = useState<ReadState>({ kind: "idle" });
  const request = useRef<AbortController | null>(null), id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  async function load() {
    if (request.current) return;
    const owner = new AbortController(); request.current = owner;
    setRead({ kind: "loading" });
    try {
      const text = await readThoughtText(target, owner.signal);
      if (request.current === owner && !owner.signal.aborted) setRead({ kind: "ready", text });
    } catch {
      if (request.current === owner && !owner.signal.aborted) setRead({ kind: "unavailable" });
    } finally { if (request.current === owner) request.current = null; }
  }
  function toggle() {
    if (expanded) {
      request.current?.abort(); request.current = null;
      if (read.kind === "loading") setRead({ kind: "idle" });
      setExpanded(false);
    } else {
      setExpanded(true);
      if (read.kind !== "ready") void load();
    }
  }
  const retry = expanded && read.kind === "unavailable";
  return <>{expanded && read.kind === "ready" ? preview?.expanded : preview?.collapsed}<DisclosureButton buttonRef={trigger} expanded={expanded} controls={id} retry={retry} onClick={retry ? () => void load() : toggle} />
    <div id={id} className="thought-text-panel" hidden={!expanded} aria-busy={expanded && read.kind === "loading"}>
      {read.kind === "loading" && <p className="text-read-status" role="status">Loading text…</p>}
      {read.kind === "unavailable" && <><p className="text-read-status" role="alert">Full text unavailable.</p><DisclosureButton expanded controls={id} onClick={(event) => { const restoreFocus = event.currentTarget === document.activeElement; toggle(); if (restoreFocus) trigger.current?.focus({ preventScroll: true }); }} /></>}
      {read.kind === "ready" && <p className="disclosed-text">{read.text}</p>}
    </div>
  </>;
}
