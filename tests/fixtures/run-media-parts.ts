import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { initialWorkerPrompt } from "../../src/agent/worker-prompts";
import type { Claim, RunRecord } from "../../src/domain/run";
import type { InitialRunContext } from "../../src/domain/run-context";
import { protocolJson } from "../../src/domain/run-protocol";
import { record } from "../../src/domain/validation";
import { immediate } from "../../src/storage/transaction";
import { mediaDigest, mediaThought } from "./media-source";
import { mediaNeighbor, type MediaWeaveFixture } from "./media-weave";

export interface OriginalPart {
  readonly position: number;
  readonly sourceId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: Uint8Array;
}
export interface OriginalManifestPart {
  readonly position: number;
  readonly sourceId: string;
  readonly representation: "original";
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly preparedKey: null;
  readonly recipe: null;
}
export interface OriginalManifest { readonly version: 1; readonly parts: readonly OriginalManifestPart[] }
export interface PartOwner { readonly run: RunRecord; readonly claim: Claim }

export function requireRunMediaParts(db: Database): void {
  const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
  expect(names).toContain("run_media_parts"); // Desired migration assertion, before querying a missing journal.
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}

export function originalParts(f: MediaWeaveFixture): readonly [OriginalPart, OriginalPart] {
  const second = { ...mediaThought, id: "parts-second-root", mediaSource: { ...mediaThought.mediaSource,
    id: "00000000-0000-4000-8000-000000000003", name: "second-controlled.png" } };
  // Trusted sentinel fingerprints only. No image decoding, original-file open or conversion is a fixture.
  f.store.saveMediaSource({ thought: second, requestKey: "parts-second-source", sha256: mediaDigest });
  const part = (position: number, sourceId: string): OriginalPart => ({ position, sourceId,
    mimeType: mediaThought.mediaSource.mimeType, byteLength: mediaThought.mediaSource.byteLength, sha256: new Uint8Array(mediaDigest) });
  return [part(0, mediaThought.mediaSource.id), part(1, second.mediaSource.id)];
}

export function startPartOwner(f: MediaWeaveFixture, kind: "weave" | "evolve" = "weave"): PartOwner {
  const run = kind === "weave" ? f.ops.admitWeave("user", { subjectId: mediaNeighbor.id, triggerId: "parts-fixture-weave" }) :
    f.admissions.admit("user", "evolve", { parentId: mediaNeighbor.id, text: "Develop this with the separately retained originals" }).run;
  return { run, claim: f.runs.claim(run.id) };
}

export function originalManifest(parts: readonly OriginalPart[]): OriginalManifest {
  return { version: 1, parts: parts.map((part): OriginalManifestPart => ({ ...part, representation: "original", sha256: Buffer.from(part.sha256).toString("hex"),
    preparedKey: null, recipe: null })) };
}

/** An internal versioned input field, not a native URI, byte payload, application capability or observation receipt. */
export function manifestInput(context: InitialRunContext, media: unknown): string {
  return protocolJson({ ...record(JSON.parse(initialWorkerPrompt(context))), media });
}

export function insertOriginalPart(db: Database, promptId: string, part: OriginalPart): void {
  db.run(`INSERT INTO run_media_parts(prompt_id,position,source_id,representation,mime_type,byte_length,sha256,prepared_key,recipe_json)
    VALUES (?,?,?,'original',?,?,?,NULL,NULL)`, [promptId, part.position, part.sourceId, part.mimeType, part.byteLength, part.sha256]);
}

/** Test-owned stand-in for the short SQL commit phase after external preparation, using existing journal entrypoints. */
export function sealOriginalParts(f: MediaWeaveFixture, owner: PartOwner, parts: readonly OriginalPart[],
  render: (context: InitialRunContext, manifest: OriginalManifest) => string = manifestInput) {
  return immediate(f.db, () => {
    for (const part of parts) insertOriginalPart(f.db, owner.run.promptId, part);
    return f.state.prepareInitial(owner.claim, context => render(context, originalManifest(parts)));
  });
}

export function partSnapshot(db: Database) {
  return db.query(`SELECT prompt_id,position,source_id,representation,mime_type,byte_length,sha256,prepared_key,recipe_json,observed
    FROM run_media_parts ORDER BY prompt_id,position`).all();
}
