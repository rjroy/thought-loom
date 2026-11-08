/** Public retained-media descriptor, never the daemon's managed file path. */
export interface MediaIdeaThought {
  readonly id: string; readonly text: null; readonly title: string | null; readonly titleAuthor?: "user" | "ai" | null;
  readonly author: "source"; readonly kind: "media-original"; readonly origin: "media-import";
  readonly parentId: null; readonly sourceIds: readonly string[]; readonly createdAt: string; readonly rejected?: boolean;
  readonly mediaSource: MediaDescriptor;
}
export interface MediaDescriptor { readonly id: string; readonly name: string; readonly mimeType: string; readonly byteLength: number;
  readonly fileAuthorship: "unverified"; readonly clarification: string | null; readonly clarificationAuthor: "user" | null }
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const safeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_~.-]+$/.test(v) && v !== "." && v !== "..";
export function mediaThought(v: unknown): v is MediaIdeaThought {
  if (!object(v) || !only(v,["id","text","title","titleAuthor","author","kind","origin","parentId","sourceIds","createdAt","rejected","mediaSource"])
      || !safeId(v.id) || v.text !== null || !(v.title === null || nonempty(v.title))
      || !(v.titleAuthor === undefined || v.titleAuthor === null || v.titleAuthor === "user" || v.titleAuthor === "ai")
      || (v.titleAuthor !== undefined && ((v.title === null) !== (v.titleAuthor === null)))
      || v.author !== "source" || v.kind !== "media-original" || v.origin !== "media-import" || v.parentId !== null
      || !Array.isArray(v.sourceIds) || v.sourceIds.length !== 0 || !nonempty(v.createdAt)
      || !(v.rejected === undefined || typeof v.rejected === "boolean")) return false;
  return mediaDescriptor(v.mediaSource);
}
export function mediaDescriptor(s: unknown): s is MediaDescriptor {
  return object(s) && only(s,["id","name","mimeType","byteLength","fileAuthorship","clarification","clarificationAuthor"])
    && safeId(s.id) && nonempty(s.name) && ["image/png","image/jpeg","image/gif","image/webp","application/pdf"].includes(String(s.mimeType))
    && typeof s.byteLength === "number" && Number.isSafeInteger(s.byteLength) && s.byteLength > 0 && s.fileAuthorship === "unverified"
    && ((s.clarification === null && s.clarificationAuthor === null) || (nonempty(s.clarification) && s.clarificationAuthor === "user"));
}
