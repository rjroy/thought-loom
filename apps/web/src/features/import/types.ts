export interface ImportBatch {
  readonly id: string;
  readonly namespaceId: string;
  readonly createdAt: string;
  readonly sealedAt: string | null;
  readonly state: "open" | "processing" | "completed";
  readonly counts: { readonly admitted: number; readonly pending: number; readonly imported: number; readonly skippedIdentical: number; readonly skippedChanged: number; readonly failed: number; readonly interrupted: number };
}
export type Segmentation = { readonly method: "ai" | "not-needed"; readonly reason: null } | { readonly method: "structural"; readonly reason: "ai-unconfigured" | "ai-unavailable" | "ai-failed" | "ai-invalid" | "ai-context-unavailable" };
export type ImportFileState = "waiting" | "queued" | "submitting" | "running" | "uncertain" | "imported" | "skipped-identical" | "skipped-changed" | "failed" | "interrupted";
export interface ImportFile {
  readonly id: string; readonly importId: string; readonly position: number; readonly relativePath: string; readonly byteLength: number; readonly createdAt: string;
  readonly state: ImportFileState; readonly runId: string | null; readonly documentId: string | null; readonly thoughtCount: number | null;
  readonly segmentation: Segmentation | null; readonly error: { readonly code: string; readonly retryable: boolean } | null;
}
export interface ImportRun { readonly id: string; readonly kind: "import"; readonly importId: string; readonly fileId: string; readonly status: "queued" | "submitting" | "running" | "uncertain" | "completed" | "failed" | "interrupted"; }
export interface ImportSource {
  readonly id: string; readonly originalNamespaceId: string; readonly originalPath: string; readonly byteLength: number; readonly sha256: string;
  readonly encoding: "utf-8"; readonly createdAt: string; readonly parserVersion: string; readonly segmentation: Segmentation; readonly thoughtCount: number;
}
export interface SourcePart { readonly position: number; readonly kind: "thought" | "separator" | "frontmatter" | "bom"; readonly startByte: number; readonly endByte: number; readonly thoughtId: string | null; readonly ordinal: number | null; readonly rejected?: boolean; }
export interface ImportPage<T> { readonly items: readonly T[]; readonly nextCursor: string | null; }
export type ImportRead<T> = { readonly kind: "found"; readonly value: T } | { readonly kind: "unavailable" | "error" };
export type ImportWrite<T> = { readonly kind: "confirmed"; readonly value: T } | { readonly kind: "not-applied"; readonly status: number } | { readonly kind: "uncertain" };
export interface SelectedFile { readonly id: string; readonly file: File; readonly relativePath: string; readonly key: string; }
export interface LocalFileIssue { readonly id: string; readonly name: string; readonly message: string; }
