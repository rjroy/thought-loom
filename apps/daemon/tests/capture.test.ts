import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-capture-"));
  directories.push(directory);
  return join(directory, "thoughtloom.sqlite");
}

function captureRequest(databasePath: string, key: string, body: string) {
  return createApp({ databasePath }).request("/captures", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body,
  });
}

function rows(databasePath: string) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return {
      sources: db.query("SELECT id, text, provenance, created_at FROM sources").all(),
      jobs: db.query("SELECT source_id, status FROM jobs").all(),
    };
  } finally {
    db.close();
  }
}

test("capture persists the original and its queued job across reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-capture-"));
  directories.push(directory);
  const databasePath = join(directory, "thoughtloom.sqlite");
  const original = "  A thought,\nwith its original spacing.  ";
  const provenance = "manual";

  const response = await createApp({ databasePath }).request("/captures", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "capture-1" },
    body: JSON.stringify({ text: original, provenance }),
  });

  expect(response.status).toBe(201);
  const captured = (await response.json()) as { id: string; createdAt: string };
  expect(captured.id).toBeTruthy();
  expect(Number.isNaN(Date.parse(captured.createdAt))).toBe(false);

  const reopened = createApp({ databasePath });
  const sourceResponse = await reopened.request(`/sources/${captured.id}`);
  expect(sourceResponse.status).toBe(200);
  expect(await sourceResponse.json()).toMatchObject({
    id: captured.id,
    text: original,
    provenance,
    createdAt: captured.createdAt,
  });

  const db = new Database(databasePath, { readonly: true });
  try {
    const jobs = db.query("SELECT status FROM jobs WHERE source_id = ?").all(captured.id);
    expect(jobs).toEqual([{ status: "queued" }]);
  } finally {
    db.close();
  }
});

test("replaying the same key and payload after reopening returns the original capture without duplicates", async () => {
  const databasePath = await temporaryDatabasePath();
  const body = JSON.stringify({ text: "A retryable thought", provenance: "manual" });
  const first = await captureRequest(databasePath, "retry-key", body);
  expect(first.status).toBe(201);
  const original = await first.json() as { id: string; text: string; provenance: string; createdAt: string };

  const replay = await captureRequest(databasePath, "retry-key", body);
  expect([200, 201]).toContain(replay.status);
  expect(await replay.json()).toEqual(original);
  const reopened = await createApp({ databasePath }).request(`/sources/${original.id}`);
  expect(await reopened.json()).toEqual(original);
  expect(rows(databasePath)).toEqual({
    sources: [{ id: original.id, text: original.text, provenance: original.provenance, created_at: original.createdAt }],
    jobs: [{ source_id: original.id, status: "queued" }],
  });
});

test("reusing a key with changed payload conflicts without changing the original or its job", async () => {
  const databasePath = await temporaryDatabasePath();
  const first = await captureRequest(databasePath, "conflict-key", JSON.stringify({ text: "First", provenance: "manual" }));
  expect(first.status).toBe(201);
  const original = await first.json() as { id: string; text: string; provenance: string; createdAt: string };

  const conflict = await captureRequest(databasePath, "conflict-key", JSON.stringify({ text: "Changed", provenance: "manual" }));
  expect(conflict.status).toBe(409);
  const reopened = await createApp({ databasePath }).request(`/sources/${original.id}`);
  expect(await reopened.json()).toEqual(original);
  expect(rows(databasePath)).toEqual({
    sources: [{ id: original.id, text: original.text, provenance: original.provenance, created_at: original.createdAt }],
    jobs: [{ source_id: original.id, status: "queued" }],
  });
});

test("a failed job insert rolls back capture, hides internal errors, and allows recovery", async () => {
  const databasePath = await temporaryDatabasePath();
  const app = createApp({ databasePath });
  expect((await app.request("/sources/not-present")).status).toBe(404);
  const db = new Database(databasePath);
  try {
    db.run(`CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN
      SELECT RAISE(ABORT, 'private-test-database-error');
    END`);
    const body = JSON.stringify({ text: "Save only with a job", provenance: "manual" });
    const failed = await captureRequest(databasePath, "recovery-key", body);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await failed.text()).not.toContain("private-test-database-error");
    expect(rows(databasePath)).toEqual({ sources: [], jobs: [] });

    db.run("DROP TRIGGER fail_job");
    const recovered = await captureRequest(databasePath, "recovery-key", body);
    expect(recovered.status).toBe(201);
    const source = await recovered.json() as { id: string };
    const saved = rows(databasePath);
    expect(saved.sources).toHaveLength(1);
    expect(saved.jobs).toEqual([{ source_id: source.id, status: "queued" }]);
  } finally {
    db.close();
  }
});

test("malformed capture input is rejected without saving rows", async () => {
  const databasePath = await temporaryDatabasePath();
  expect((await createApp({ databasePath }).request("/sources/not-present")).status).toBe(404);
  expect((await captureRequest(databasePath, "invalid-json", "{")).status).toBe(400);
  expect((await captureRequest(databasePath, "invalid-fields", JSON.stringify({ text: 42, provenance: "manual" }))).status).toBe(400);
  expect(rows(databasePath)).toEqual({ sources: [], jobs: [] });
});
