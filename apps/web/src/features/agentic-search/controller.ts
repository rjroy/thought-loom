import { clientClock, createSearchClient, SearchRequestError, type SearchClient } from "./request";
import { terminal, type Admission, type Catalog, type Composer, type Content, type Discovery, type Effort, type Message, type NormalPage, type Page, type Preview, type Run, type Snapshot, type Workspace } from "./types";

const blank = (): Workspace => ({session:null,phase:"loading",context:{kind:"unopened"},content:{kind:"unopened"},draft:"",blockedDraft:null,effort:"standard",admission:{kind:"idle"},busy:false,observationError:false,scrollY:0});
const emptyPage = <T>(): Page<T> => ({items:[],nextCursor:null});
const normal = (content: Content, composerId: string): content is Extract<Content,{kind:"normal"}> => content.kind === "normal" && content.composerId === composerId;
const contextChanged = (error: unknown) => error instanceof SearchRequestError && error.status === 409 && error.code === "context-changed";
const knownFailure = (error: unknown) => error instanceof SearchRequestError && [400,403,404,409,413,415,503].includes(error.status);

/** One mounted browser workspace. Never creates work during construction, render, or read-only navigation. */
export function createAgenticSearchController(client: SearchClient = createSearchClient(), key: () => string = () => crypto.randomUUID(), clock = clientClock) {
  const workspaces = new Map<string,Workspace>(), listeners = new Set<() => void>(), epochs = new Map<string,number>(), queues = new Map<string,Promise<void>>();
  // Positions only: a failed refresh may retry the same coverage without retaining stale prose.
  const coverage = new Map<string,{ readonly composerId: string; readonly messages: number; readonly discoveries: number; readonly revision: number }>();
  let catalog: Catalog = {phase:"idle",items:[],nextCursor:null};
  const notify = () => { for (const listener of listeners) listener(); };
  const update = (id: string, change: (value: Workspace) => Workspace) => { const old = workspaces.get(id); if (old) { workspaces.set(id,change(old)); notify(); } };
  const epoch = (id: string) => epochs.get(id) ?? 0;
  const invalidate = (id: string) => { epochs.set(id,epoch(id)+1); };
  const composerCurrent = (id: string, composerId: string, generation: number) => { const value = workspaces.get(id); return epoch(id) === generation && value?.context.kind === "editable" && value.context.composer.composerId === composerId; };
  const markChanged = (id: string) => { invalidate(id); update(id,w => ({...w,context:{kind:"changed",blockedDraft:w.draft},blockedDraft:w.draft,content:{kind:"unopened"},busy:false})); };
  const queue = (id: string, task: () => Promise<void>) => {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task).finally(() => { if (queues.get(id) === next) queues.delete(id); });
    queues.set(id,next); return next;
  };
  async function loadCatalog(cursor?: string): Promise<void> {
    catalog = {...catalog,phase:"loading"}; notify();
    try { const page = await client.catalog(cursor); catalog = {phase:"ready",items:cursor ? [...catalog.items,...page.items.filter(item => !catalog.items.some(old => old.id === item.id))] : page.items,nextCursor:page.nextCursor}; }
    catch (error) {
      if (cursor && error instanceof SearchRequestError && (error.code === "list-changed" || error.status === 400)) { await loadCatalog(); return; }
      catalog = {...catalog,phase:"error"};
    }
    notify();
  }
  async function loadMetadata(id: string): Promise<void> {
    if (!workspaces.has(id)) workspaces.set(id,blank());
    const generation = epoch(id); notify();
    try { const metadata = await client.metadata(id); if (epoch(id) !== generation) return;
      update(id,w => ({...w,session:metadata.session,phase:"ready",admission:w.admission.kind === "idle" && metadata.activeRun ? {kind:"known",run:metadata.activeRun} : w.admission}));
    } catch { if (epoch(id) === generation) update(id,w => ({...w,phase:w.session ? "ready" : "error",observationError:true})); }
  }
  async function readPage(id: string, kind: "messages" | "discoveries", cursor?: string): Promise<void> {
    const initial = workspaces.get(id);
    if (!initial || initial.context.kind !== "editable") return;
    const composerId = initial.context.composer.composerId, generation = epoch(id);
    update(id,w => ({...w,busy:true}));
    return queue(id,async () => {
      const w = workspaces.get(id); if (!composerCurrent(id,composerId,generation) || !w || w.admission.kind === "submitting" || w.admission.kind === "unconfirmed") return;
      try {
        const selected = kind === "messages" ? {kind:"messages" as const,page:await client.messages(id,composerId,cursor)} : {kind:"discoveries" as const,page:await client.discoveries(id,composerId,cursor)};
        const page = selected.page;
        if (!composerCurrent(id,composerId,generation) || !("composerId" in page) || page.composerId !== composerId) return;
        update(id,current => {
          if (current.context.kind !== "editable" || current.context.composer.composerId !== composerId) return current;
          const old = normal(current.content,composerId) ? current.content : {kind:"normal" as const,composerId,messages:emptyPage<Message>(),discoveries:emptyPage<Discovery>(),preview:null,revision:0};
          if (page.sessionRevision < old.revision) return {...current,context:{kind:"editable",composer:{composerId,contextToken:page.contextToken,eligibilityRevision:page.eligibilityRevision}}};
          const next = selected.kind === "messages" ? {...old,messages:{items:cursor ? [...old.messages.items,...selected.page.items] : selected.page.items,nextCursor:page.nextCursor}} :
            {...old,discoveries:{items:cursor ? [...old.discoveries.items,...selected.page.items] : selected.page.items,nextCursor:page.nextCursor}};
          return {...current,context:{kind:"editable",composer:{composerId,contextToken:page.contextToken,eligibilityRevision:page.eligibilityRevision}},content:{...next,revision:Math.max(old.revision,page.sessionRevision)},observationError:false};
        });
      } catch (error) { if (composerCurrent(id,composerId,generation)) { if (contextChanged(error)) markChanged(id); else update(id,v => ({...v,observationError:true})); } }
    }).finally(() => { if (composerCurrent(id,composerId,generation)) update(id,w => ({...w,busy:false})); });
  }
  async function readNormal(id: string): Promise<void> {
    const initial = workspaces.get(id);
    if (!initial || initial.context.kind !== "editable" || initial.admission.kind === "submitting" || initial.admission.kind === "unconfirmed") return;
    const composerId = initial.context.composer.composerId;
    const previous = normal(initial.content,composerId) ? initial.content : null;
    const saved = coverage.get(id), prior = saved?.composerId === composerId ? saved : null;
    const messageThrough = Math.max(previous?.messages.items.at(-1)?.position ?? -1,prior?.messages ?? -1);
    const discoveryThrough = Math.max(previous?.discoveries.items.at(-1)?.position ?? -1,prior?.discoveries ?? -1);
    const floor = Math.max(previous?.revision ?? 0,prior?.revision ?? 0);
    coverage.set(id,{composerId,messages:messageThrough,discoveries:discoveryThrough,revision:floor});
    // Supersede queued reads. Keep the last validated same-composer snapshot in place while
    // the refresh runs, so the reader's geometry does not collapse; failures clear it.
    invalidate(id); const generation = epoch(id);
    update(id,w => ({...w,busy:true,content:previous ?? {kind:"normal",composerId,messages:emptyPage<Message>(),discoveries:emptyPage<Discovery>(),preview:null,revision:floor}}));
    return queue(id,async () => {
      if (!composerCurrent(id,composerId,generation)) return;
      let revision: number | null = null, eligibility: number | null = null;
      async function walk<T extends { readonly position: number }>(through: number, read: (cursor?: string) => Promise<NormalPage<T> | Page<T>>): Promise<Page<T>> {
        const items: T[] = [], seen = new Set<string>(); let cursor: string | undefined, collectionRevision: number | null = null;
        while (true) {
          const page = await read(cursor);
          if (!composerCurrent(id,composerId,generation)) throw new Error("Search read superseded");
          if (!("composerId" in page) || page.composerId !== composerId) throw new Error("Search composer differs");
          // Every successful page extends the same server ledger, including before a later read fails.
          update(id,w => w.context.kind === "editable" && w.context.composer.composerId === composerId
            ? {...w,context:{kind:"editable",composer:{composerId,contextToken:page.contextToken,eligibilityRevision:page.eligibilityRevision}}} : w);
          const current = workspaces.get(id);
          const currentFloor = current && normal(current.content,composerId) ? current.content.revision : floor;
          if (page.sessionRevision < currentFloor || (collectionRevision !== null && page.sessionRevision !== collectionRevision) ||
              (eligibility !== null && page.eligibilityRevision !== eligibility)) throw new Error("Search page changed during refresh");
          collectionRevision = page.sessionRevision; revision = Math.max(revision ?? 0,page.sessionRevision); eligibility = page.eligibilityRevision;
          items.push(...page.items);
          if (page.nextCursor === null || (items.at(-1)?.position ?? -1) >= through) return {items,nextCursor:page.nextCursor};
          if (seen.has(page.nextCursor)) throw new Error("Search cursor did not advance");
          seen.add(page.nextCursor); cursor = page.nextCursor;
        }
      }
      try {
        const messages = await walk(messageThrough,cursor => client.messages(id,composerId,cursor));
        const discoveries = await walk(discoveryThrough,cursor => client.discoveries(id,composerId,cursor));
        let refreshedPreview: Preview | null = null;
        const previewId = previous?.preview?.thought.id;
        if (previewId && discoveries.items.some(item => item.availability === "available" && item.thought?.id === previewId)) {
          try {
            const value = await client.preview(id,composerId,previewId);
            if (!composerCurrent(id,composerId,generation)) return;
            if (value.composerId !== composerId || (eligibility !== null && value.eligibilityRevision !== eligibility) ||
              (revision !== null && value.sessionRevision < revision)) throw new Error("Search preview changed during refresh");
            update(id,w => w.context.kind === "editable" && w.context.composer.composerId === composerId
              ? {...w,context:{kind:"editable",composer:{composerId,contextToken:value.contextToken,eligibilityRevision:value.eligibilityRevision}}} : w);
            revision = Math.max(revision ?? 0,value.sessionRevision); refreshedPreview = value;
          } catch (error) {
            // A no-longer-visible idea is a normal absence, not a reason to keep its old preview.
            if (!(error instanceof SearchRequestError && error.status === 404)) throw error;
          }
        }
        if (!composerCurrent(id,composerId,generation)) return;
        update(id,w => {
          if (!normal(w.content,composerId) || revision === null || w.content.revision > revision) return {...w,content:{kind:"unopened"},observationError:true};
          coverage.set(id,{composerId,messages:Math.max(messageThrough,messages.items.at(-1)?.position ?? -1),discoveries:Math.max(discoveryThrough,discoveries.items.at(-1)?.position ?? -1),revision});
          return {...w,content:{...w.content,messages,discoveries,preview:refreshedPreview,revision},observationError:false};
        });
      } catch (error) {
        if (composerCurrent(id,composerId,generation)) {
          if (contextChanged(error)) markChanged(id); else update(id,w => ({...w,content:{kind:"unopened"},observationError:true}));
        }
      }
    }).finally(() => { if (composerCurrent(id,composerId,generation)) update(id,w => ({...w,busy:false})); });
  }
  async function resume(id: string): Promise<void> {
    const w = workspaces.get(id); if (!w || w.busy || w.context.kind === "changed") return;
    invalidate(id); const generation = epoch(id); update(id,v => ({...v,busy:true}));
    try {
      const composer = w.context.kind === "editable" ? await client.refresh(id,w.context.composer.composerId) : await client.open(id);
      if (epoch(id) !== generation) return;
      update(id,v => ({...v,busy:false,context:{kind:"editable",composer},
        content:v.context.kind === "editable" && v.context.composer.composerId === composer.composerId ? v.content : {kind:"unopened"}})); await readNormal(id);
    } catch (error) { if (epoch(id) === generation) { if (contextChanged(error)) markChanged(id); else update(id,v => ({...v,busy:false,observationError:true})); } }
  }
  async function start(): Promise<string | null> {
    try { const created = await client.create(key()), id = created.session.id; workspaces.set(id,{...blank(),session:created.session,phase:"ready"}); notify(); await resume(id); return id; }
    catch { return null; }
  }
  async function newBlankDraft(id: string): Promise<void> {
    const w = workspaces.get(id); if (!w || w.context.kind !== "changed" || w.busy) return;
    invalidate(id); const generation = epoch(id); update(id,v => ({...v,busy:true}));
    try { const composer = await client.open(id); if (epoch(id) !== generation) return;
      update(id,v => ({...v,busy:false,draft:"",context:{kind:"editable",composer},content:{kind:"unopened"}})); await readNormal(id);
    } catch { if (epoch(id) === generation) update(id,v => ({...v,busy:false,observationError:true})); }
  }
  async function send(id: string): Promise<void> {
    const w = workspaces.get(id); if (!w || w.busy || queues.has(id) || w.context.kind !== "editable" || w.content.kind !== "normal" || !w.draft.trim() || w.admission.kind === "submitting" || w.admission.kind === "unconfirmed" || (w.admission.kind === "known" && !terminal(w.admission.run))) return;
    const generation = epoch(id), snapshot: Snapshot = {key:key(),payload:{text:w.draft,startingThoughtIds:[],requestClock:clock(),effort:w.effort,contextMode:"continue",composerId:w.context.composer.composerId,contextToken:w.context.composer.contextToken}};
    update(id,v => ({...v,admission:{kind:"submitting",snapshot}}));
    try { const result = await client.admit(id,snapshot.key,snapshot.payload); const stillPresent = epoch(id) === generation; invalidate(id);
      update(id,v => ({...v,session:result.session,blockedDraft:v.draft === snapshot.payload.text ? v.blockedDraft : v.draft,draft:"",admission:{kind:"known",run:result.run},context:{kind:"unopened"},content:{kind:"unopened"}}));
      // A confirmed Send consumed the old composer. Its follow-up is a new blank context,
      // created only as part of this user action; reads then register its offered pages.
      if (stillPresent) await resume(id);
    } catch (error) {
      if (contextChanged(error)) { markChanged(id); update(id,v => ({...v,admission:{kind:"idle"}})); }
      else update(id,v => ({...v,admission:knownFailure(error) ? {kind:"not-started",reason:error instanceof SearchRequestError ? error.code ?? "not-started" : "not-started"} : {kind:"unconfirmed",snapshot}}));
    }
  }
  async function check(id: string): Promise<void> {
    const w = workspaces.get(id); if (!w || w.busy) return;
    const admission = w.admission; if (admission.kind !== "known" && admission.kind !== "unconfirmed") return;
    const generation = epoch(id); update(id,v => ({...v,busy:true}));
    try { const run = admission.kind === "known" ? await client.check(admission.run.id,id) : (await client.byKey(id,admission.snapshot.key)).run;
      if (epoch(id) !== generation) return;
      if (admission.kind === "unconfirmed") invalidate(id);
      update(id,v => ({...v,busy:false,admission:{kind:"known",run},...(admission.kind === "unconfirmed" ? {context:{kind:"unopened" as const},content:{kind:"unopened" as const},draft:v.draft === admission.snapshot.payload.text ? "" : v.draft} : {}),observationError:false}));
      const current = workspaces.get(id); if (current?.context.kind === "editable" && current.content.kind !== "history") await readNormal(id);
    } catch { if (epoch(id) === generation) update(id,v => ({...v,busy:false,observationError:true})); }
  }
  async function stop(id: string): Promise<void> {
    const w = workspaces.get(id); if (!w || w.busy || w.admission.kind !== "known" || terminal(w.admission.run)) return;
    const run = w.admission.run, generation = epoch(id);
    const ownsStop = () => { const current = workspaces.get(id); return epoch(id) === generation && current?.admission.kind === "known" && current.admission.run.id === run.id; };
    update(id,v => ({...v,busy:true}));
    try { const stopped = await client.stop(run.id); if (ownsStop()) update(id,v => stopped.id === run.id
      ? {...v,busy:false,admission:{kind:"known",run:stopped},observationError:false} : {...v,busy:false,observationError:true}); }
    catch { if (ownsStop()) update(id,v => ({...v,busy:false,observationError:true})); }
  }
  async function history(id: string): Promise<void> {
    invalidate(id); const generation = epoch(id); update(id,w => ({...w,busy:true}));
    try { const messages = await client.messages(id,null), discoveries = await client.discoveries(id,null);
      if (epoch(id) === generation) update(id,w => ({...w,busy:false,content:{kind:"history",messages,discoveries},observationError:false}));
    } catch { if (epoch(id) === generation) update(id,w => ({...w,busy:false,observationError:true})); }
  }
  async function readHistoryPage(id: string, kind: "messages" | "discoveries", cursor: string): Promise<void> {
    const current = workspaces.get(id); if (!current || current.busy || current.content.kind !== "history") return;
    const generation = epoch(id); update(id,w => ({...w,busy:true}));
    try {
      const selected = kind === "messages" ? {kind:"messages" as const,page:await client.messages(id,null,cursor)} : {kind:"discoveries" as const,page:await client.discoveries(id,null,cursor)};
      if (epoch(id) !== generation || "composerId" in selected.page) return;
      update(id,w => {
        if (w.content.kind !== "history") return w;
        const content = selected.kind === "messages" ? {...w.content,messages:{items:[...w.content.messages.items,...selected.page.items],nextCursor:selected.page.nextCursor}} :
          {...w.content,discoveries:{items:[...w.content.discoveries.items,...selected.page.items],nextCursor:selected.page.nextCursor}};
        return {...w,content,observationError:false};
      });
    } catch { if (epoch(id) === generation) update(id,w => ({...w,observationError:true})); }
    finally { if (epoch(id) === generation) update(id,w => ({...w,busy:false})); }
  }
  async function preview(id: string, thoughtId: string): Promise<void> {
    update(id,w => ({...w,busy:true}));
    return queue(id,async () => { const w = workspaces.get(id); if (!w || w.context.kind !== "editable" || w.admission.kind === "submitting" || w.admission.kind === "unconfirmed") return;
      const composerId = w.context.composer.composerId, generation = epoch(id);
      try { const value: Preview = await client.preview(id,composerId,thoughtId); if (!composerCurrent(id,composerId,generation) || value.composerId !== composerId) return;
        update(id,current => current.context.kind === "editable" && normal(current.content,composerId) && value.sessionRevision >= current.content.revision ? {...current,context:{kind:"editable",composer:{composerId,contextToken:value.contextToken,eligibilityRevision:value.eligibilityRevision}},content:{...current.content,preview:value,revision:value.sessionRevision}} : current);
      } catch (error) { if (composerCurrent(id,composerId,generation)) { if (contextChanged(error)) markChanged(id); else update(id,v => ({...v,observationError:true})); } }
    }).finally(() => update(id,w => ({...w,busy:false})));
  }
  async function removeOccurrence(id: string, entryId: string): Promise<void> {
    try { const revision = await client.removeOccurrence(id,entryId);
      const saved = coverage.get(id); if (saved) coverage.set(id,{...saved,revision:Math.max(saved.revision,revision)});
      update(id,w => w.content.kind === "normal" ? {...w,content:{...w.content,revision:Math.max(w.content.revision,revision),discoveries:{...w.content.discoveries,items:w.content.discoveries.items.filter(item => item.id !== entryId)}}} : w); }
    catch { update(id,w => ({...w,observationError:true})); }
  }
  async function rename(id: string, title: string): Promise<void> { const w = workspaces.get(id); if (!w?.session || w.busy) return; update(id,v => ({...v,busy:true})); try { const result = await client.rename(id,title,w.session.revision); update(id,v => ({...v,busy:false,session:result.session})); } catch { update(id,v => ({...v,busy:false,observationError:true})); } }
  async function removeSession(id: string): Promise<boolean> { const w = workspaces.get(id); if (!w || w.busy) return false; update(id,v => ({...v,busy:true})); try { await client.removeSession(id); invalidate(id); update(id,v => ({...v,busy:false,phase:"deleted",content:{kind:"unopened"},context:{kind:"unopened"}})); return true; } catch { update(id,v => ({...v,busy:false,observationError:true})); return false; } }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(id: string): Workspace | null { return workspaces.get(id) ?? null; }, getCatalog: () => catalog,
    loadCatalog, loadMetadata, start, resume, newBlankDraft, send, check, stop, history, readHistoryPage, preview, removeOccurrence, rename, removeSession, readPage, readNormal,
    changeDraft(id: string, draft: string) { update(id,w => ({...w,draft})); }, changeEffort(id: string, effort: Effort) { update(id,w => ({...w,effort})); },
    saveScroll(id: string, scrollY: number) { update(id,w => ({...w,scrollY})); }, leave(id: string) { invalidate(id); client.cancelReads(id); update(id,w => ({...w,busy:false})); },
  };
}
export type AgenticSearchController = ReturnType<typeof createAgenticSearchController>;
