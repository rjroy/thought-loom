"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Image from "next/image";
import { createSettingsController, settingsCanSave, settingsDirty } from "../features/settings/controller";
import { createAgentInstructionsClient } from "../features/settings/request";
import { instructionFields, type InstructionField } from "../features/settings/types";
import styles from "./settings.module.css";

const labels: Record<InstructionField, { name: string; description: string }> = {
  weaver: { name: "Weaver", description: "Interpretations and connections" },
  evolve: { name: "Evolve", description: "Developing ideas in conversation" },
  search: { name: "Agentic Search", description: "Finding existing thinking" },
  export: { name: "Agentic Export", description: "Writing a Markdown report" },
};

export function SettingsView() {
  const [controller] = useState(() => createSettingsController(createAgentInstructionsClient(fetch)));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { void controller.load(); return controller.disconnect; }, [controller]);
  const dirty = settingsDirty(state), pending = state.pending !== null;
  const loaded = state.baseline !== null;
  const status = pending ? "Saving changes…"
    : state.phase === "idle" || state.phase === "loading" ? "Loading instructions…"
    : state.saved ? dirty ? "Earlier changes saved. You have unsaved changes." : "Changes saved."
    : dirty && !state.problem ? "Unsaved changes." : "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    await controller.save();
    const firstInvalid = instructionFields.find(field => controller.getSnapshot().fieldErrors[field]);
    if (firstInvalid) form.current?.querySelector<HTMLTextAreaElement>(`#settings-${firstInvalid}`)?.focus();
  }

  return <section className={styles.workspace} aria-labelledby="settings-heading">
    <h1 id="settings-heading">Settings</h1>
    <div className={styles.introRow}>
      <div className={styles.intro}>
        <h2>Additional agent instructions</h2>
        <p>Add guidance for each agent. It supplements built-in instructions, without overriding permissions or data-protection rules.</p>
        <p className={styles.scope} id="settings-scope">Applies across Thoughtloom, not just this browser. Leave a field empty for no extra guidance.</p>
      </div>
      <Image src="/backgrounds/settings-notebook.png" alt="" aria-hidden="true"
        width={160} height={90} unoptimized loading="eager" draggable={false} className={styles.whimsy} />
    </div>
    {state.problem?.kind === "read" && <p className={styles.problem} role="alert">{state.problem.message}</p>}
    <form ref={form} noValidate onSubmit={event => { void submit(event); }}>
      <div className={styles.fields}>
        {instructionFields.map(field => {
          const id = `settings-${field}`, error = state.fieldErrors[field];
          return <div className={styles.field} key={field}>
            <div>
              <label htmlFor={id}>{labels[field].name} <span>(optional)</span></label>
              <p className={styles.description} id={`${id}-description`}>{labels[field].description}</p>
            </div>
            <div>
              <textarea id={id} value={state.draft[field]} disabled={!loaded} aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-description settings-scope${error ? ` ${id}-error` : ""}`}
                placeholder={loaded ? "No additional guidance" : "Not loaded yet"}
                onChange={event => controller.edit(field, event.target.value)} />
              {error && <p id={`${id}-error`} className={styles.fieldError} role="alert">{error}</p>}
            </div>
          </div>;
        })}
      </div>
      <div className={styles.actions}>
        <p className={styles.timing} id="settings-timing">Saved changes apply on the next agent turn, including in existing conversations. Running turns stay unchanged.</p>
        <button type="submit" aria-describedby="settings-timing" aria-busy={pending}
          disabled={!settingsCanSave(state)}>Save changes</button>
      </div>
      <p className={`${styles.status}${state.saved && !dirty ? ` ${styles.saved}` : ""}`} role="status" aria-atomic="true">{status}</p>
      {state.problem && state.problem.kind !== "read" && <p className={styles.problem} role="alert">{state.problem.message}</p>}
    </form>
  </section>;
}
