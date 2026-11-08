"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { submitCapture, type CaptureSnapshot } from "../features/capture/submission";
import { useCaptureMemory, type CaptureState } from "./capture-provider";
import styles from "./capture.module.css";

export function CaptureForm() {
  const memory = useCaptureMemory(), router = useRouter();
  const initial = useRef(memory.current);
  const [text, setText] = useState(initial.current?.text ?? "");
  const [title, setTitle] = useState(initial.current?.title ?? "");
  const [state, setState] = useState<CaptureState>(initial.current?.state ?? { kind: "editing" });
  const [validation, setValidation] = useState<string | null>(initial.current?.validation ?? null);
  const inFlight = useRef(false);
  const thoughtField = useRef<HTMLTextAreaElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const focusNewDraft = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const importChoices = useRef<HTMLDivElement>(null);

  useEffect(() => { memory.current = null; }, [memory]);

  function openImport(destination: string) {
    if (inFlight.current) return;
    memory.current = { text, title, state, validation };
    setImportOpen(false);
    router.push(destination);
  }

  useEffect(() => {
    if (!importOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !importChoices.current?.contains(event.target)) setImportOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [importOpen]);

  useEffect(() => {
    if (state.kind === "saving" && thoughtField.current) {
      thoughtField.current.scrollTop = 0;
    }
    if (state.kind === "saved" || state.kind === "uncertain") {
      resultHeading.current?.focus();
    }
    if (state.kind === "editing" && focusNewDraft.current) {
      focusNewDraft.current = false;
      thoughtField.current?.focus();
    }
  }, [state.kind]);

  async function save(snapshot: CaptureSnapshot) {
    // React's disabled state follows the render; this guard also fences same-tick submissions.
    if (inFlight.current) return;
    if (!snapshot.text.trim()) {
      setValidation("Write a thought before saving.");
      thoughtField.current?.focus();
      return;
    }

    const submitted = Object.freeze({ ...snapshot });
    inFlight.current = true;
    setImportOpen(false);
    setValidation(null);
    setState({ kind: "saving", snapshot: submitted });
    try {
      setState(await submitCapture(submitted, { fetch: window.fetch.bind(window) }));
    } finally {
      inFlight.current = false;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || state.kind === "uncertain" || state.kind === "saved") return;
    void save({ text, ...(title === "" ? {} : { title }) });
  }

  function captureAnother() {
    setText("");
    setTitle("");
    setValidation(null);
    focusNewDraft.current = true;
    setState({ kind: "editing" });
  }

  const pending = state.kind === "saving";
  const locked = pending || state.kind === "uncertain";
  const snapshot = state.kind === "saving" || state.kind === "uncertain" ? state.snapshot : undefined;

  return (
    <>
    <header className={`workspace-intro capture-heading ${styles.heading}`}>
      <div className={styles.headingRow} ref={importChoices} onKeyDown={event => {
        if (event.key === "Escape" && importOpen) { event.preventDefault(); setImportOpen(false); importButton.current?.focus(); }
      }}>
        <h1 id="capture-heading"><Image src="/glyphs/sprout.svg" alt="" aria-hidden="true" width={24} height={24} unoptimized className={styles.headingGlyph} />Capture</h1>
        <button ref={importButton} className={styles.importAction} type="button" disabled={pending}
          aria-expanded={importOpen} aria-controls="capture-import-choices" onClick={() => { if (!inFlight.current) setImportOpen(open => !open); }}>Import</button>
        <div id="capture-import-choices" className={styles.importChoices} hidden={!importOpen}>
          <button className={styles.importChoice} type="button" onClick={() => openImport("/import/media")}>
            <strong>Image or PDF</strong><span>Keep one original file and request an AI interpretation.</span>
          </button>
          <button className={styles.importChoice} type="button" onClick={() => openImport("/import")}>
            <strong>Markdown</strong><span>Bring in original words without rewriting them.</span>
          </button>
          <p>Your Capture draft stays here.</p>
        </div>
      </div>
      <p>Write or paste a thought.</p>
    </header>
    <div className="capture-content">
      <div className={`capture-status capture-status--${state.kind}`} role="status" aria-atomic="true">
        {state.kind === "saving" && (
          <>
            <h2>Saving…</h2>
            <p>Waiting for confirmation. Your draft is still here.</p>
          </>
        )}
        {state.kind === "saved" && (
          <>
            <h2 ref={resultHeading} tabIndex={-1}>Saved.</h2>
            <p>Your original wording is saved. You can continue without waiting for background processing.</p>
          </>
        )}
        {state.kind === "not-saved" && (
          <>
            <h2>Not saved</h2>
            <p>{state.message} Your draft is still here. You can adjust it and try again.</p>
          </>
        )}
        {state.kind === "uncertain" && (
          <>
            <h2 ref={resultHeading} tabIndex={-1}>Not sure it saved</h2>
            <p>{state.message} This thought may already be saved.</p>
          </>
        )}
      </div>

      {state.kind === "saved" ? (
        <>
          <dl className="capture-receipt">
            <dt>Thought</dt>
            <dd>{state.receipt.text}</dd>
            {state.receipt.title !== null && (
              <>
                <dt>Title</dt>
                <dd>{state.receipt.title}</dd>
              </>
            )}
          </dl>
          <div className="capture-actions capture-actions--saved">
            <Link className="capture-button capture-button--primary" href={`/ideas/${encodeURIComponent(state.receipt.id)}`} prefetch={false}>
              Open idea
            </Link>
            <button className="capture-button" type="button" onClick={captureAnother}>
              Capture another thought
            </button>
          </div>
        </>
      ) : (
        <form className="capture-form" data-recovery={state.kind !== "editing"} noValidate onSubmit={handleSubmit}>
          <div className="capture-field">
            <label htmlFor="capture-thought">Thought</label>
            <textarea
              id="capture-thought"
              className="capture-control capture-thought"
              ref={thoughtField}
              required
              value={snapshot?.text ?? text}
              readOnly={locked}
              aria-invalid={validation ? true : undefined}
              aria-describedby={validation ? "capture-thought-error" : undefined}
              onChange={(event) => {
                if (locked || inFlight.current) return;
                setText(event.target.value);
                setValidation(null);
              }}
            />
            {validation && <p className="capture-field-error" id="capture-thought-error" role="alert">{validation}</p>}
          </div>
          <div className="capture-field">
            <label htmlFor="capture-title">Title <span className="capture-optional">(optional)</span></label>
            <input
              id="capture-title"
              className="capture-control"
              type="text"
              value={snapshot ? snapshot.title ?? "" : title}
              readOnly={locked}
              onChange={(event) => {
                if (!locked && !inFlight.current) setTitle(event.target.value);
              }}
            />
          </div>

          {state.kind === "uncertain" ? (
            <div className="capture-recovery-actions">
              <div>
                <a className="capture-button capture-button--primary" href="/explore" target="_blank" rel="noopener noreferrer">
                  Open Explore in new tab
                </a>
                <p className="capture-hint">Keep this draft open. Finding similar text does not confirm this save.</p>
              </div>
              <div>
                <button className="capture-button" type="button" aria-describedby="capture-duplicate-warning" onClick={() => void save(state.snapshot)}>
                  Save another copy
                </button>
                <p className="capture-hint" id="capture-duplicate-warning">This may create a duplicate.</p>
              </div>
            </div>
          ) : (
            <div className="capture-actions">
              <button className="capture-button capture-button--primary" type="submit" disabled={pending} aria-busy={pending}>
                {state.kind === "not-saved" ? "Retry save" : "Save"}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
    </>
  );
}
