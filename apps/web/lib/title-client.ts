import { isRecordId, isThoughtTitleText, parseThoughtTitle, type ThoughtTitle } from "@thoughtloom/contracts";

export type TitleTarget = { kind: "source" } | { kind: "item"; itemId: string; versionId: string };
export type TitleView = { headRevisionId: string | null; title: ThoughtTitle | null };
export type TitleInput = { target: TitleTarget; text: string; expectedTitleRevisionId: string | null };

export function parseTitleTarget(value: unknown): TitleTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) return null;
  if (value.kind === "source" && Object.keys(value).length === 1) return { kind: "source" };
  return value.kind === "item" && "itemId" in value && "versionId" in value && isRecordId(value.itemId) && isRecordId(value.versionId) && Object.keys(value).length === 3
    ? { kind: "item", itemId: value.itemId, versionId: value.versionId } : null;
}
export function parseTitleInput(value: unknown): TitleInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 3 || !("target" in value) || !("text" in value) || !("expectedTitleRevisionId" in value)) return null;
  const target = parseTitleTarget(value.target), expected = value.expectedTitleRevisionId;
  return target && isThoughtTitleText(value.text) && (expected === null || isRecordId(expected)) ? { target, text: value.text, expectedTitleRevisionId: expected } : null;
}
export function parseTitleView(value: unknown): TitleView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("headRevisionId" in value) || !("title" in value)) return null;
  const head = value.headRevisionId, title = value.title === null ? null : parseThoughtTitle(value.title);
  return (head === null || isRecordId(head)) && (value.title === null || title !== null) && (head !== null || title === null)
    ? { headRevisionId: head, title } : null;
}
export function titlePath(root: string, target: TitleTarget, read = false): string {
  return `/api/sources/${encodeURIComponent(root)}/title${read && target.kind === "item" ? `?${new URLSearchParams({ itemId: target.itemId, versionId: target.versionId })}` : ""}`;
}
export function titleTargetKey(target: TitleTarget): string { return target.kind === "source" ? "source" : JSON.stringify([target.itemId, target.versionId]); }
export function titleEntityKey(target: TitleTarget): string { return JSON.stringify(target.kind === "source" ? ["source"] : ["item", target.itemId]); }
export class TitleError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function getTitle(root: string, target: TitleTarget, signal?: AbortSignal): Promise<TitleView> {
  console.info("title.read attempt", { root });
  try {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(titlePath(root, target, true), { cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const view = response.ok ? parseTitleView(await response.json()) : null;
    if (!view) throw new TitleError(response.status, "title_unavailable");
    console.info("title.read succeeded", { root }); return view;
  } catch (error) { console.warn("title.read unavailable", { root }); throw error; }
}
export async function saveTitle(root: string, input: TitleInput, key: string, signal?: AbortSignal): Promise<ThoughtTitle> {
  console.info("title.save attempt", { root });
  try {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(titlePath(root, input.target), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "title_unconfirmed";
      throw new TitleError(response.status, code);
    }
    const receipt = parseThoughtTitle(body);
    if (response.status !== 200 || !receipt || receipt.author !== "user" || receipt.text !== input.text) throw new TitleError(503, "title_unconfirmed");
    console.info("title.save acknowledged", { root }); return receipt;
  } catch (error) {
    console.warn("title.save unresolved", { root, status: error instanceof TitleError ? error.status : 0 });
    throw error instanceof TitleError ? error : new TitleError(503, "title_unconfirmed");
  }
}
