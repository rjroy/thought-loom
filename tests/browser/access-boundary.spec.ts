import { expect, test, type APIRequestContext } from "@playwright/test";
import { accessHost } from "../fixtures/access-host";

const marker = "private-access-fixture-zirconium";
const privateHost = `${accessHost}:4317`;
const privateOrigin = `http://${privateHost}`;

async function seed(request: APIRequestContext) {
  const capture = await request.post("/api/captures", { headers: { "idempotency-key": `access-${crypto.randomUUID()}` }, data: { text: marker, provenance: "test fixture" } });
  expect(capture.status()).toBe(201);
  const source = await capture.json() as { id: string };
  const dialogue = await request.post(`/api/sources/${source.id}/dialogues`, { headers: { "idempotency-key": `dialogue-${crypto.randomUUID()}` }, data: { selection: { kind: "source", id: source.id } } });
  expect(dialogue.status()).toBe(201);
  return { source, dialogue: await dialogue.json() as { id: string } };
}

test("loopback UI and BFF preserve normal no-Origin and same-origin requests", async ({ request, baseURL }) => {
  const { source } = await seed(request);
  const response = await request.get(`/api/sources/${source.id}`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ id: source.id, text: marker });
  expect((await request.get(`/sources/${source.id}`)).status()).toBe(200);
  const sameOrigin = await request.post("/api/captures", { headers: { origin: baseURL ?? "", "idempotency-key": `same-origin-${crypto.randomUUID()}` }, data: { text: "same-origin fixture", provenance: "test fixture" } });
  expect(sameOrigin.status()).toBe(201);
});

test("rebinding Host cannot read BFF private data or server-rendered source despite forwarded loopback hint", async ({ request }) => {
  const { source, dialogue } = await seed(request);
  for (const path of ["/api/search?q=zirconium", `/api/sources/${source.id}`, `/api/dialogues/${dialogue.id}`, `/api/sources/${source.id}/weaving`, `/sources/${source.id}`]) {
    const response = await request.get(path, { headers: { host: "attacker.example:4317", "x-forwarded-host": "127.0.0.1:4317", "x-forwarded-proto": "http" } });
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain(marker);
  }
});

test("malformed authorities and hostile origins cannot read or mutate local BFF", async ({ request }) => {
  const { source } = await seed(request);
  for (const host of ["127.0.0.1@attacker.example:4317", "127.0.0.1:4317,attacker.example", "localhost:4317:443"]) {
    const response = await request.get(`/api/sources/${source.id}`, { headers: { host } });
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain(marker);
  }
  for (const headers of [{ host: "attacker.example:4317", "x-forwarded-host": "127.0.0.1:4317" }, { origin: "http://attacker.example" }]) {
    const response = await request.post("/api/captures", { headers: { ...headers, "idempotency-key": `rejected-${crypto.randomUUID()}` }, data: { text: "hostile-access-insert", provenance: "test fixture" } });
    expect(response.status()).toBe(403);
  }
  const search = await request.get("/api/search?q=hostile-access-insert");
  expect((await search.json() as { results: unknown[] }).results).toEqual([]);
});

test("hostile Origin cannot read a private BFF response through a local Host", async ({ request }) => {
  const { source } = await seed(request);
  const response = await request.get(`/api/sources/${source.id}`, { headers: { origin: "http://attacker.example" } });
  expect(response.status()).toBe(403);
  expect(await response.text()).not.toContain(marker);
});

test("approved HTTP hostname reaches pages, reads and capture through the BFF", async ({ request }) => {
  const headers = { host: privateHost, origin: privateOrigin };
  const capture = await request.post("/api/captures", { headers: { ...headers, "idempotency-key": `private-${crypto.randomUUID()}` }, data: { text: marker, provenance: "test fixture" } });
  expect(capture.status()).toBe(201);
  const source = await capture.json() as { id: string };
  const read = await request.get(`/api/sources/${source.id}`, { headers });
  expect(read.status()).toBe(200);
  expect(await read.json()).toMatchObject({ id: source.id, text: marker });
  const page = await request.get(`/sources/${source.id}`, { headers: { host: privateHost } });
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain(marker);
});

test("approved HTTP origin reaches dialogue and title commands while retaining request guards", async ({ request }) => {
  const { source } = await seed(request);
  const headers = { host: privateHost, origin: privateOrigin, "idempotency-key": crypto.randomUUID() };
  const dialogue = await request.post(`/api/sources/${source.id}/dialogues`, { headers, data: { selection: { kind: "source", id: source.id } } });
  expect(dialogue.status()).toBe(201);
  const title = await request.post(`/api/sources/${source.id}/title`, { headers: { ...headers, "idempotency-key": crypto.randomUUID() }, data: { target: { kind: "source" }, text: "Private fixture title", expectedTitleRevisionId: null } });
  expect(title.status()).toBe(200);
  expect(await title.json()).toMatchObject({ text: "Private fixture title" });
  const crossSite = await request.post(`/api/sources/${source.id}/dialogues`, { headers: { ...headers, "sec-fetch-site": "cross-site" }, data: { selection: { kind: "source", id: source.id } } });
  expect(crossSite.status()).toBe(403);
  const retry = await request.post(`/api/sources/${source.id}/weaving/retry`, { headers: { ...headers, "content-type": "text/plain" }, data: "not json" });
  expect(retry.status()).toBe(415);
});

test("approved host does not trust lookalike hosts or foreign origins", async ({ request }) => {
  const { source } = await seed(request);
  const cases: Record<string, string>[] = [
    { host: `${accessHost}.attacker.example:4317`, origin: privateOrigin },
    { host: privateHost, origin: `http://${accessHost}.attacker.example:4317` },
    { host: privateHost, origin: "http://localhost:4317" },
    { host: privateHost, origin: `http://${accessHost}:4318` },
    { host: privateHost, origin: privateOrigin, "x-forwarded-host": "attacker.example:4317" },
    { host: privateHost, origin: privateOrigin, "x-forwarded-proto": "https" },
    { host: privateHost, origin: privateOrigin, forwarded: "host=localhost" },
  ];
  for (const headers of cases) {
    const read = await request.get(`/api/sources/${source.id}`, { headers });
    expect(read.status()).toBe(403);
    expect(await read.text()).not.toContain(marker);
    const write = await request.post("/api/captures", { headers: { ...headers, "idempotency-key": crypto.randomUUID() }, data: { text: "rejected fixture", provenance: "test fixture" } });
    expect(write.status()).toBe(403);
  }
});
