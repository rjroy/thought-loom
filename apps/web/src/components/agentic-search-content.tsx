"use client";

import Link from "next/link";
import { useState } from "react";
import type { Discovery, Message, Page, Workspace } from "../features/agentic-search/types";
import { searchHistoryHref, searchSessionHref } from "../features/agentic-search/location";
import { useAgenticSearchController } from "./agentic-search-provider";
import styles from "./agentic-search.module.css";
import { MediaSourceDetails } from "./media-source-details";
import { ThoughtMarkdown } from "./thought-markdown";

const kinds = {
  "captured-original": "Original capture", "user-contribution": "Contribution", "ai-interpretation": "Interpretation",
  "developing-idea": "Developing idea", "imported-original": "Imported source", "media-original": "Image or PDF",
} as const;

export function SearchConversation({ page, more, busy }: { readonly page: Page<Message>; readonly more: () => void; readonly busy: boolean }) {
  return <section aria-labelledby="search-conversation-heading" className={styles.conversation}>
    <h2 id="search-conversation-heading">Conversation</h2>
    {page.items.length === 0 && <p className={styles.empty}>No messages yet.</p>}
    <ol className={styles.messages}>{page.items.map(message => <li className={styles.messageRow} key={message.id}>
      <p className={message.role === "user" ? styles.user : styles.ai}>{message.role === "user" ? "You" : "AI"}</p>
      <div className={message.role === "user" ? styles.userMessage : styles.aiMessage}>
        {message.text !== null ? <p className={styles.message}>{message.text}</p> : <p className={styles.metadata}>Message unavailable because its context changed.</p>}
        {message.disposition === "awaiting-user" && message.availability === "available" && <p className={styles.metadata}>Waiting for your answer</p>}
      </div>
    </li>)}</ol>
    {page.nextCursor && <button className={styles.textButton} type="button" disabled={busy} onClick={more}>More messages</button>}
  </section>;
}

export function SearchDiscoveries({ id, workspace, history, rememberPosition }: {
  readonly id: string; readonly workspace: Workspace; readonly history: boolean; readonly rememberPosition: () => void;
}) {
  const controller = useAgenticSearchController();
  const [removing, setRemoving] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const content = workspace.content;
  if (content.kind === "unopened" || (history && content.kind !== "history") || (!history && content.kind !== "normal")) return null;
  const preview = content.kind === "normal" ? content.preview : null;
  const returnTo = history ? searchHistoryHref(id) : searchSessionHref(id);
  async function remove(entryId: string) {
    if (removing) return;
    setRemoving(entryId); setNotice(null);
    await controller.removeOccurrence(id, entryId);
    const after = controller.get(id);
    if (after?.content.kind === "normal" && !after.content.discoveries.items.some(item => item.id === entryId)) setNotice("Removed from this search. The idea remains in your library.");
    setRemoving(null);
  }
  return <>
    {content.discoveries.items.length === 0 && <p className={styles.empty}>No discovered ideas yet.</p>}
    <ol className={styles.discoveries}>{content.discoveries.items.map(entry => <li key={entry.id} className={styles.discovery}>
      <DiscoveryHeading entry={entry} />
      {history && entry.availability === "thought-unavailable" && <p className={styles.metadata}>Idea unavailable in normal search</p>}
      {history && entry.reasonStatus === "context-unavailable" && <p className={styles.metadata}>Historical explanation · unavailable to the agent</p>}
      {entry.removedAt && <p className={styles.metadata}>Removed from this search</p>}
      <p className={styles.rationale}><strong>Why relevant: </strong>{entry.why ?? "Explanation unavailable because its context changed."}</p>
      {entry.thought && <div className={styles.actions}>
        {!history && <button className={styles.button} type="button" disabled={workspace.busy || workspace.context.kind !== "editable" || workspace.admission.kind === "submitting" || workspace.admission.kind === "unconfirmed"}
          onClick={() => { if (entry.thought) void controller.preview(id, entry.thought.id); }}>Preview</button>}
        <Link className={`${styles.button} ${styles.primary}`} prefetch={false} onNavigate={rememberPosition}
          href={`/ideas/${encodeURIComponent(entry.thought.id)}?${new URLSearchParams({ returnTo, ...(history ? { scope: "history" } : {}) })}`}>Open idea</Link>
        {!history && <button className={`${styles.textButton} ${styles.dangerText}`} type="button" disabled={removing !== null || workspace.busy} onClick={() => void remove(entry.id)}>{removing === entry.id ? "Removing…" : "Remove from search"}</button>}
      </div>}
      {!history && preview && preview.thought.id === entry.thought?.id && <section className={styles.preview} aria-label="Idea preview">
        <h4>{preview.thought.title ?? (preview.thought.kind === "media-original" ? preview.thought.mediaSource.name : preview.thought.text.trim().split(/\s+/).slice(0, 5).join(" "))}</h4>
        {preview.thought.kind === "media-original" ? <>
          <MediaSourceDetails source={preview.thought.mediaSource} compact />
          <p className={styles.metadata}>Search can read this descriptor, clarification and recorded interpretations. It cannot open the original file.</p>
        </> : <ThoughtMarkdown className={styles.message} text={preview.thought.text} headingLevel={5} />}
      </section>}
    </li>)}</ol>
    {notice && <p role="status" className={styles.metadata}>{notice}</p>}
    {content.discoveries.nextCursor && <button className={styles.textButton} type="button" disabled={workspace.busy} onClick={() => {
      const cursor = content.discoveries.nextCursor;
      if (cursor) void (history ? controller.readHistoryPage(id, "discoveries", cursor) : controller.readPage(id, "discoveries", cursor));
    }}>More discovered ideas</button>}
    {!history && <p className={styles.policy}>Removing an entry keeps the library idea. A later search may find it again.</p>}
  </>;
}

function DiscoveryHeading({ entry }: { readonly entry: Discovery }) {
  const thought = entry.thought;
  if (!thought) return <h3>Idea unavailable</h3>;
  return <><h3>{thought.title ?? "Untitled idea"}</h3><p className={styles.byline}>
    <span className={thought.author === "user" ? styles.user : thought.author === "ai" ? styles.ai : styles.source}>{thought.author === "user" ? "You" : thought.author === "ai" ? "AI" : "Imported source"}</span> · <span>{kinds[thought.kind]}</span>
  </p></>;
}
