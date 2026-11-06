"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { createImport, listImportFiles, listImports, readImport, readImportFile, readImportRun, sealImport, stopImportRun, uploadImportFile } from "../features/import/request";
import type { ImportBatch, ImportFile, ImportRun, LocalFileIssue, SelectedFile } from "../features/import/types";

export interface ImportReport {
  readonly batch: ImportBatch | null; readonly files: readonly ImportFile[]; readonly cursor: string | null;
  readonly loadedPages: number;
  readonly state: "loading" | "ready" | "unavailable"; readonly checking: boolean; readonly readError: boolean;
  readonly fileMessages: Readonly<Record<string, string>>; readonly busyFiles: readonly string[]; readonly runs: Readonly<Record<string, ImportRun>>;
}
interface ImportWorkspace {
  readonly selected: readonly SelectedFile[]; readonly issues: readonly LocalFileIssue[];
  readonly admission: "setup" | "pending" | "not-started" | "known" | "uncertain";
  readonly batchId: string | null; readonly snapshot: readonly SelectedFile[]; readonly message: string | null;
  readonly batchKey: string | null;
  readonly reports: Readonly<Record<string, ImportReport>>;
  readonly recent: readonly ImportBatch[]; readonly recentCursor: string | null; readonly recentBusy: boolean; readonly recentError: boolean;
}
const terminal = (file: ImportFile) => ["imported", "skipped-identical", "skipped-changed", "failed", "interrupted"].includes(file.state);
const terminalRun = (run: ImportRun) => ["completed", "failed", "interrupted"].includes(run.status);
const emptyReport = (): ImportReport => ({ batch: null, files: [], cursor: null, loadedPages: 1, state: "loading", checking: false, readError: false, fileMessages: {}, busyFiles: [], runs: {} });
type Watcher = { count: number; generation: number; controller: AbortController | null; busy: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null };

function createImportStore() {
  let state: ImportWorkspace = { selected: [], issues: [], admission: "setup", batchId: null, batchKey: null, snapshot: [], message: null, reports: {}, recent: [], recentCursor: null, recentBusy: false, recentError: false };
  const listeners = new Set<() => void>(), watchers = new Map<string, Watcher>();
  const browserFetch: typeof fetch = (input, init) => window.fetch(input, init);
  const update = (change: Partial<ImportWorkspace>) => { state = { ...state, ...change }; for (const listener of listeners) listener(); };
  const reportUpdate = (id: string, change: Partial<ImportReport>) => update({ reports: { ...state.reports, [id]: { ...(state.reports[id] ?? emptyReport()), ...change } } });
  const clearTimer = (watcher: Watcher) => { if (watcher.timer !== null) clearTimeout(watcher.timer); watcher.timer = null; };
  function schedule(id: string) {
    const watcher = watchers.get(id), report = state.reports[id];
    if (!watcher) return;
    clearTimer(watcher);
    if (watcher.count && report?.batch && report.batch.counts.pending > 0 && !report.busyFiles.length) watcher.timer = setTimeout(() => { void check(id); }, 2000);
  }
  function check(id: string, more = false): Promise<void> {
    const watcher = watchers.get(id), previous = state.reports[id];
    if (!watcher?.count || previous?.busyFiles.length || (state.batchId === id && state.admission === "pending")) return Promise.resolve();
    if (watcher.busy) return watcher.busy;
    clearTimer(watcher);
    const generation = ++watcher.generation, controller = new AbortController();
    watcher.controller = controller;
    const deps = { fetch: browserFetch, signal: controller.signal };
    const current = () => watcher.count > 0 && watcher.generation === generation && !controller.signal.aborted;
    reportUpdate(id, { checking: true });
    const operation = (async () => {
      try {
        const [batch, files] = await Promise.all([readImport(id, deps), listImportFiles(id, more ? previous?.cursor ?? null : null, deps)]);
        if (!current()) return;
        if (batch.kind === "unavailable") { reportUpdate(id, { batch: null, files: [], state: "unavailable", readError: false }); return; }
        const change: Partial<ImportReport> = { readError: batch.kind !== "found" || files.kind !== "found" };
        if (batch.kind === "found") Object.assign(change, { batch: batch.value.import, state: "ready" });
        if (files.kind === "found") {
          const observed = [...files.value.items];
          let cursor = files.value.nextCursor, pages = 1, pageError = false;
          // Recheck only pages already opened by the user, not an unbounded
          // background crawl. Later loaded rows must not become stale forever.
          if (!more) while (cursor && pages < (previous?.loadedPages ?? 1)) {
            const next = await listImportFiles(id, cursor, deps);
            if (!current()) return;
            if (next.kind !== "found") { pageError = true; break; }
            observed.push(...next.value.items); cursor = next.value.nextCursor; pages++;
          }
          // Batch membership is append-only. Rechecking the first page must not
          // erase later pages the user has already opened.
          const merged = [...(previous?.files ?? []), ...observed];
          Object.assign(change, {
            files: [...new Map(merged.map(file => [file.id, file])).values()].sort((a, b) => a.position - b.position),
            cursor: pageError ? previous?.cursor ?? null : cursor,
            loadedPages: more ? (previous?.loadedPages ?? 1) + 1 : pageError ? previous?.loadedPages ?? pages : pages,
            readError: batch.kind !== "found" || pageError,
          });
        }
        reportUpdate(id, change);
      } finally {
        if (current()) { watcher.busy = null; watcher.controller = null; reportUpdate(id, { checking: false }); schedule(id); }
      }
    })();
    watcher.busy = operation;
    return operation;
  }
  function fence(id: string) {
    const watcher = watchers.get(id);
    if (watcher) { clearTimer(watcher); watcher.generation++; watcher.controller?.abort(); watcher.controller = null; watcher.busy = null; }
  }
  async function fileAction(id: string, fileId: string, stop: boolean) {
    const report = state.reports[id], file = report?.files.find(item => item.id === fileId);
    if (!report || !file || report.busyFiles.includes(fileId) || (stop && (!file.runId || terminal(file) || (report.runs[fileId] && terminalRun(report.runs[fileId]))))) return;
    // Freeze the known identity. A subsequent report read cannot redirect this command.
    const known = file.runId ? Object.freeze({ id: file.runId, importId: id, fileId }) : null;
    fence(id);
    reportUpdate(id, { checking: false, busyFiles: [...report.busyFiles, fileId] });
    let message: string | null = null;
    if (stop && known) {
      const result = await stopImportRun(known, { fetch: browserFetch });
      if (result.kind === "confirmed") {
        reportUpdate(id, { runs: { ...state.reports[id]!.runs, [fileId]: result.value } });
        message = terminalRun(result.value) ? `Run ${result.value.status}. Check this file for its saved outcome.` : "Stop requested. The run has not yet confirmed its final outcome.";
      } else message = result.kind === "uncertain" ? "Stop outcome uncertain. Check this same file; Stop has not been replayed." : "Stop was not applied. Check this same file for its current status.";
    } else {
      const [result, run] = await Promise.all([readImportFile(id, fileId, { fetch: browserFetch }), known ? readImportRun(known, { fetch: browserFetch }) : Promise.resolve(null)]);
      if (result.kind === "found") reportUpdate(id, { files: state.reports[id]!.files.map(item => item.id === fileId ? result.value.file : item) });
      else message = result.kind === "unavailable" ? "This file is unavailable. No new upload was made." : "Could not check this file. Its last confirmed outcome is still shown.";
      if (run?.kind === "found") reportUpdate(id, { runs: { ...state.reports[id]!.runs, [fileId]: run.value } });
      else if (run) message = "Could not confirm this run. Its last confirmed file outcome is still shown.";
    }
    const latest = state.reports[id]!;
    const messages = { ...latest.fileMessages };
    if (message) messages[fileId] = message; else delete messages[fileId];
    reportUpdate(id, { busyFiles: latest.busyFiles.filter(value => value !== fileId), fileMessages: messages });
    schedule(id);
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(files: FileList | readonly File[]) {
      if (["pending", "uncertain"].includes(state.admission)) return;
      const selected = [...state.selected], issues = [...state.issues];
      for (const file of Array.from(files)) {
        const id = crypto.randomUUID(), relativePath = file.webkitRelativePath || file.name;
        if (!/\.(?:md|markdown)$/i.test(file.name)) issues.push({ id, name: relativePath, message: "Choose a Markdown file instead. This file is not included in the import." });
        else selected.push(Object.freeze({ id, file, relativePath, key: crypto.randomUUID() }));
      }
      update({ selected, issues, admission: "setup", message: null });
    },
    remove(id: string) { if (!["pending", "uncertain"].includes(state.admission)) update({ selected: state.selected.filter(file => file.id !== id), issues: state.issues.filter(file => file.id !== id) }); },
    async admit() {
      if (!state.selected.length || !["setup", "not-started"].includes(state.admission)) return;
      const snapshot = Object.freeze(state.selected.map(file => Object.freeze({ ...file }))), key = crypto.randomUUID();
      update({ snapshot, batchKey: key, admission: "pending", message: null, batchId: null });
      const result = await createImport(key, { fetch: browserFetch });
      if (result.kind !== "confirmed") {
        update({ admission: result.kind === "uncertain" ? "uncertain" : "not-started", message: result.kind === "uncertain" ? "Batch admission uncertain. No files have been sent, and no replacement batch will be created automatically. Check Recent imports before starting another import." : "The import was not started. Your selection is still here; you can try deliberately again." });
        return;
      }
      const id = result.value.import.id;
      reportUpdate(id, { batch: result.value.import, state: "ready" });
      update({ batchId: id });
      const notSent: LocalFileIssue[] = [];
      for (let index = 0; index < snapshot.length; index++) {
        const file = snapshot[index]!;
        update({ message: `Sending ${file.relativePath}. Waiting for an admission receipt.` });
        const receipt = await uploadImportFile(id, file, { fetch: browserFetch });
        if (receipt.kind === "uncertain") {
          const remaining = snapshot.slice(index + 1).map(item => ({ id: item.id, name: item.relativePath, message: "Not uploaded because an earlier file’s admission could not be confirmed. This file is not included in admitted totals." }));
          update({ admission: "uncertain", issues: [...state.issues, ...notSent, ...remaining], message: `Admission uncertain for ${file.relativePath}. Its exact bytes and request identity are retained in this tab. Do not import it again: a receipt was not confirmed. Remaining selected files were not sent; the batch has not been sealed.` });
          void check(id);
          return;
        }
        if (receipt.kind === "not-applied") {
          notSent.push({ id: file.id, name: file.relativePath, message: receipt.status === 413 ? "The configured upload size limit was exceeded. This file was not admitted." : "The file was not admitted. The other files can continue; a new import is a separate request." });
        } else {
          const current = state.reports[id]!;
          reportUpdate(id, { files: [...current.files.filter(item => item.id !== receipt.value.file.id), receipt.value.file] });
        }
      }
      update({ issues: [...state.issues, ...notSent], message: "All selected files have admission outcomes. Finishing the batch…" });
      const sealed = await sealImport(id, { fetch: browserFetch });
      if (sealed.kind === "confirmed") {
        reportUpdate(id, { batch: sealed.value.import, state: "ready" });
        update({ admission: "known", selected: [], message: null });
      } else update({ admission: "uncertain", message: "Could not confirm that the batch was sealed. Check this same report. No files will be uploaded again automatically." });
      void check(id);
    },
    watch(id: string) {
      let watcher = watchers.get(id);
      if (!watcher) { watcher = { count: 0, generation: 0, controller: null, busy: null, timer: null }; watchers.set(id, watcher); }
      watcher.count++;
      if (!state.reports[id]) reportUpdate(id, {});
      // Observation is read-only, including a fresh bookmark or a mounted return.
      void check(id);
      return () => { watcher!.count--; if (!watcher!.count) { fence(id); reportUpdate(id, { checking: false }); } };
    },
    check,
    checkFile: (id: string, fileId: string) => fileAction(id, fileId, false),
    stopFile: (id: string, fileId: string) => fileAction(id, fileId, true),
    async recent(more = false) {
      if (state.recentBusy) return;
      const cursor = more ? state.recentCursor : null;
      update({ recentBusy: true });
      const result = await listImports(cursor, { fetch: browserFetch });
      update(result.kind === "found" ? { recent: more ? [...new Map([...state.recent, ...result.value.items].map(batch => [batch.id, batch])).values()] : result.value.items, recentCursor: result.value.nextCursor, recentBusy: false, recentError: false } : { recentBusy: false, recentError: true });
    },
    reset() {
      if (["pending", "uncertain"].includes(state.admission)) return;
      update({ selected: [], issues: [], admission: "setup", snapshot: [], batchKey: null, message: null, batchId: null });
    },
  };
}

const ImportContext = createContext<ReturnType<typeof createImportStore> | null>(null);
export function ImportProvider({ children }: { children: ReactNode }) {
  const store = useRef<ReturnType<typeof createImportStore> | null>(null);
  if (store.current === null) store.current = createImportStore();
  return <ImportContext.Provider value={store.current}>{children}</ImportContext.Provider>;
}
export function useImportStore() {
  const store = useContext(ImportContext);
  if (!store) throw new Error("Import requires its mounted workspace provider.");
  return store;
}
