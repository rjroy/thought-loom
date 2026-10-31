import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { CaptureInput, Source } from "@thoughtloom/contracts";

function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  try {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
      if (version?.user_version === 0) {
        db.run(`CREATE TABLE sources (
          id TEXT PRIMARY KEY NOT NULL,
          text TEXT NOT NULL,
          provenance TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`);
        db.run(`CREATE TABLE jobs (
          id TEXT PRIMARY KEY NOT NULL,
          source_id TEXT NOT NULL REFERENCES sources(id),
          status TEXT NOT NULL
        )`);
        db.run("PRAGMA user_version = 1");
      } else if (version?.user_version !== 1 && version?.user_version !== 2) {
        throw new Error("Unsupported database schema version");
      }
      if (version?.user_version === 0 || version?.user_version === 1) {
        db.run(`CREATE TABLE capture_receipts (
          idempotency_key TEXT PRIMARY KEY NOT NULL,
          payload_hash TEXT NOT NULL,
          source_id TEXT NOT NULL UNIQUE REFERENCES sources(id)
        )`);
        db.run("PRAGMA user_version = 2");
      }
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

type CaptureResult =
  | { kind: "created" | "replayed"; source: Source }
  | { kind: "conflict" };

export function saveCapture(path: string, key: string, input: CaptureInput): CaptureResult {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify([input.text, input.provenance]), "utf8")
    .digest("hex");
  const db = openDatabase(path);
  try {
    return db.transaction((): CaptureResult => {
      const receipt = db.query<{ payload_hash: string; source_id: string }, [string]>(
        "SELECT payload_hash, source_id FROM capture_receipts WHERE idempotency_key = ?",
      ).get(key);
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) return { kind: "conflict" };
        const source = db.query<Source, [string]>(
          "SELECT id, text, provenance, created_at AS createdAt FROM sources WHERE id = ?",
        ).get(receipt.source_id);
        if (!source) throw new Error("Capture receipt references a missing source");
        return { kind: "replayed", source };
      }
      const source: Source = {
        id: crypto.randomUUID(),
        text: input.text,
        provenance: input.provenance,
        createdAt: new Date().toISOString(),
      };
      db.run("INSERT INTO sources (id, text, provenance, created_at) VALUES (?, ?, ?, ?)",
        [source.id, source.text, source.provenance, source.createdAt]);
      db.run("INSERT INTO jobs (id, source_id, status) VALUES (?, ?, ?)",
        [crypto.randomUUID(), source.id, "queued"]);
      db.run("INSERT INTO capture_receipts (idempotency_key, payload_hash, source_id) VALUES (?, ?, ?)",
        [key, payloadHash, source.id]);
      return { kind: "created", source };
    }).immediate();
  } finally {
    db.close();
  }
}

export function findSource(path: string, id: string): Source | null {
  const db = openDatabase(path);
  try {
    return db.query<Source, [string]>(
      "SELECT id, text, provenance, created_at AS createdAt FROM sources WHERE id = ?",
    ).get(id);
  } finally {
    db.close();
  }
}
