import { afterEach, expect, test } from "bun:test";
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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thoughtloom-search-"));
  directories.push(directory);
  const databasePath = join(directory, "thoughtloom.sqlite");
  const app = createApp({ databasePath });
  async function capture(key: string, text: string) {
    const response = await app.request("/captures", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ text, provenance: "manual" }),
    });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; text: string; provenance: string; createdAt: string };
  }
  const exact = await capture("exact", "A lantern guides careful thinking.");
  const prefix = await capture("prefix", "Lanterns illuminate an idea.");
  const unrelated = await capture("unrelated", "A quiet garden after rain.");
  return { databasePath, exact, prefix, unrelated };
}

type SearchResponse = {
  results: Array<{ sourceId: string; matchOrigin: "source" | "annotation" | "alias" }>;
};

test("source search ranks an exact token above a prefix and excludes unrelated sources", async () => {
  const { databasePath, exact, prefix, unrelated } = await fixture();
  const response = await createApp({ databasePath }).request("/search?q=Lantern");
  expect(response.status).toBe(200);
  const { results } = await response.json() as SearchResponse;
  expect(results[0]).toMatchObject({ sourceId: exact.id, matchOrigin: "source" });
  expect(results).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: prefix.id, matchOrigin: "source" }),
  ]));
  expect(results.map((result) => result.sourceId)).not.toContain(unrelated.id);
});

test("unfinished source terms remain searchable after reopening", async () => {
  const { databasePath, exact, prefix, unrelated } = await fixture();
  const response = await createApp({ databasePath }).request("/search?q=lant");
  expect(response.status).toBe(200);
  const { results } = await response.json() as SearchResponse;
  expect(results.map((result) => result.sourceId)).toEqual(expect.arrayContaining([exact.id, prefix.id]));
  expect(results.map((result) => result.sourceId)).not.toContain(unrelated.id);
  expect(results.every((result) => result.matchOrigin === "source")).toBe(true);
});
