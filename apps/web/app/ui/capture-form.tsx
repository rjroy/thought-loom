"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CaptureInput, Source } from "@thoughtloom/contracts";
import { parseSource } from "../../lib/source";
import StatusIcon from "./status-icon";

type Attempt = { key: string; input: CaptureInput };

export default function CaptureForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedAfterFailure, setEditedAfterFailure] = useState(false);
  const [saved, setSaved] = useState<Source | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef<Attempt | null>(null);
  const inFlight = useRef(false);

  function changeText(value: string) {
    if (attempt.current && value !== attempt.current.input.text) {
      attempt.current = null;
      setEditedAfterFailure(true);
    }
    setText(value);
    setError(null);
    setSaved(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !text.trim()) return;
    const current = attempt.current ?? {
      key: crypto.randomUUID(),
      input: { text, provenance: "Manual web capture" },
    };
    attempt.current = current;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    console.info("capture.request attempt");
    try {
      const response = await fetch("/api/captures", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": current.key },
        body: JSON.stringify(current.input),
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 409) {
        console.warn("capture.request conflict");
        setError("This save key conflicts with an earlier capture. Your draft is still here. Edit the draft to begin a new save, or copy it before leaving this tab.");
        editor.current?.focus({ preventScroll: true });
        return;
      }
      if (response.status !== 200 && response.status !== 201) throw new Error("Unconfirmed save");
      const source = parseSource(await response.json());
      if (!source || source.text !== current.input.text || source.provenance !== current.input.provenance) {
        throw new Error("Invalid save receipt");
      }
      console.info("capture.request succeeded", { sourceId: source.id });
      // The field is read-only during the request. Clear only this acknowledged payload.
      setSaved(source);
      setText("");
      attempt.current = null;
      setEditedAfterFailure(false);
      router.push(`/sources/${source.id}`);
    } catch {
      console.warn("capture.request failed", { category: "unconfirmed_save" });
      setError("Save could not be confirmed. Your draft is still here. Try again without editing to check the same save.");
      editor.current?.focus({ preventScroll: true });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="capture-form" aria-busy={saving}>
      <label htmlFor="thought">Your thought</label>
      <p className="field-help" id="thought-help">No title or polished question needed. Your words will be saved exactly as written.</p>
      <textarea
        ref={editor}
        id="thought"
        name="thought"
        value={text}
        onChange={(event) => changeText(event.target.value)}
        readOnly={saving}
        required
        aria-describedby={`thought-help${error ? " save-error" : ""}${editedAfterFailure ? " edited-warning" : ""}`}
        placeholder="An observation, an unfinished question, a line worth returning to…"
        rows={8}
      />
      {error && <div className="notice error-notice" role="alert" id="save-error"><StatusIcon kind="error" /><p>{error}</p></div>}
      {editedAfterFailure && <p className="edited-warning" id="edited-warning">You changed the draft. Saving now creates a new original; the earlier attempt may already be saved.</p>}
      <div className="capture-actions">
        <p className="draft-state" role="status">{saving ? "Saving original…" : text ? "Not saved yet. Save before leaving this page." : "Your original is saved before weaving begins."}</p>
        <button className="button primary" type="submit" disabled={saving || !text.trim()}>{saving ? "Saving…" : error ? "Retry save" : "Save original"}</button>
      </div>
      {saved && <div className="notice" role="status"><StatusIcon kind="saved" /><p><strong>Original saved</strong>. <Link href={`/sources/${saved.id}`}>Open your saved original</Link>.</p></div>}
    </form>
  );
}
