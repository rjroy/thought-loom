import { describe, expect, test } from "bun:test";
import { createApp, type BoundaryEvent } from "../src/daemon/app";
import { RejectionService, type RejectionSnapshot } from "../src/domain/rejection";
import type { Thought } from "../src/domain/thought";
import type { Connection } from "../src/domain/connection";
import { MemoryRepository } from "./rejection-fixtures";
import { CreationService, type CreationWrites } from "../src/domain/creation";
import { TitleService, type TitleRecord } from "../src/domain/title";

// Contract: bare JSON records/arrays; ?scope=normal|history|show-rejected.
// POST /thoughts, /thoughts/:id/contributions, /thoughts/:id/developments, /connections.
// PUT /thoughts/:id/title and POST /thoughts/:id/title/fill return full joined thoughts.
// GET collections and /:id; GET /responses/:id.
// POST /thoughts/:id/{reject,restore}, /connections/:id/{reject,restore};
// GET /thoughts/:id/branch/preview; POST /thoughts/:id/branch/{reject,restore}.
// Branch reject body is the exact preview, including rootId, branchIds, affectedIds and count.
const credentials = { user: "user-secret-token", ai: "ai-secret-token" };
const thoughtInput = { text: "sensitive new text" };
const connectionInput = { fromId: "root", toId: "outside", category: "supports", explanation: "sensitive rationale", sourceIds: ["child"] } as const;

function setup(failWrites = false, extra: Partial<Pick<RejectionSnapshot, "thoughts" | "connections" | "responses">> = {}) {
  const repo = new class extends MemoryRepository {
    override snapshot(): RejectionSnapshot {
      const snapshot = super.snapshot();
      return { ...snapshot, thoughts: [...snapshot.thoughts, ...(extra.thoughts ?? [])],
        connections: [...snapshot.connections, ...(extra.connections ?? [])], responses: [...snapshot.responses, ...(extra.responses ?? [])] };
    }
  }();
  const rejection = new RejectionService(repo);
  const createdThoughts: Thought[] = [];
  const createdConnections: Connection[] = [];
  const events: BoundaryEvent[] = [];
  const writes: CreationWrites = {
    createThought: thought => { if (failWrites) throw new Error("SQL secret internal failure"); createdThoughts.push(thought); },
    createConnection: connection => { createdConnections.push(connection); },
  };
  let sequence = 0;
  const creation = new CreationService({ rejection, writes, id: () => `generated-${++sequence}`, now: () => "2030-01-02T03:04:05.000Z" });
  const titles = new Map<string, TitleRecord>(repo.snapshot().thoughts.map(item => [item.id, { title: item.title, titleAuthor: item.titleAuthor ?? null, rejected: false }]));
  const titleService = new TitleService({ transaction: action => action({ get: id => {
    const value = titles.get(id);
    return value ? { ...value, rejected: repo.snapshot().rejectedThoughtIds.includes(id) } : null;
  }, set: (id, value) => { titles.set(id, { ...value, rejected: false }); } }) });
  const app = createApp({ rejection, creation, titles: titleService, credentials, logger: event => events.push(event) });
  function request(path: string, options: { actor?: "user" | "ai" | "bad" | "none"; method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
    const actor = options.actor ?? "user";
    const headers: Record<string, string> = { ...options.headers };
    if (actor !== "none") headers.authorization = `Bearer ${actor === "bad" ? "invalid-secret" : credentials[actor]}`;
    let body = options.raw;
    if (options.body !== undefined) body = JSON.stringify(options.body);
    if (body !== undefined) headers["content-type"] = "application/json";
    return app.request(path, { method: options.method ?? "GET", headers, body });
  }
  return { repo, rejection, createdThoughts, createdConnections, events, request };
}

describe("daemon API contract", () => {
  test("semantic commands derive immutable identity, attribution and provenance", async () => {
    const t = setup();
    const result = await t.request("/thoughts", { method: "POST", body: { ...thoughtInput, title: "Label" } });
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ ...thoughtInput, id: "generated-1", title: "Label", titleAuthor: "user", author: "user", kind: "captured-original", createdAt: "2030-01-02T03:04:05.000Z", origin: "capture", parentId: null, sourceIds: [] });
    expect(t.createdThoughts).toHaveLength(1);
    expect(Object.isFrozen(t.createdThoughts[0])).toBe(true);
    const link = await t.request("/connections", { method: "POST", body: connectionInput });
    expect(link.status).toBe(201);
    expect(await link.json()).toEqual({ ...connectionInput, id: "generated-2", proposedBy: "user" });
    expect(Object.isFrozen(t.createdConnections[0])).toBe(true);
    expect((await t.request("/thoughts", { method: "POST", actor: "ai", body: thoughtInput })).status).toBe(403);
    expect((await t.request("/connections", { method: "POST", actor: "ai", body: { ...connectionInput, proposedBy: "user" } })).status).toBe(400);
    expect(t.createdThoughts).toHaveLength(1);
    expect(t.createdConnections).toHaveLength(1);
    expect((await t.request("/thoughts/root", { method: "PATCH", body: { text: "edit" } })).status).toBe(404);
  });

  test("title commands preserve thought attribution and enforce fill eligibility", async () => {
    const t = setup();
    const edited = await t.request("/thoughts/child/title", { method: "PUT", body: { title: "Human label" } });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ ...t.rejection.listThoughts({ actor: "user", mode: "normal" }).find(item => item.id === "child"), title: "Human label", titleAuthor: "user" });
    expect((await t.request("/thoughts/child/title/fill", { method: "POST", actor: "ai", body: { title: "late" } })).status).toBe(409);
    expect((await t.request("/thoughts/child/title", { method: "PUT", actor: "ai", body: { title: null } })).status).toBe(403);
    const cleared = await t.request("/thoughts/child/title", { method: "PUT", body: { title: null } });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).titleAuthor).toBeNull();
    const filled = await t.request("/thoughts/child/title/fill", { method: "POST", actor: "ai", body: { title: "AI label" } });
    expect(filled.status).toBe(200);
    expect(await filled.json()).toEqual({ ...t.rejection.listThoughts({ actor: "user", mode: "normal" }).find(item => item.id === "child"), title: "AI label", titleAuthor: "ai" });
    t.rejection.rejectThought("user", "root");
    expect((await t.request("/thoughts/root/title/fill", { method: "POST", actor: "ai", body: { title: "hidden" } })).status).toBe(404);
    expect((await t.request("/thoughts/root/title", { method: "PUT", body: { title: "human" } })).status).toBe(200);
  });

  test("contributions and developments require the correct actor and selected parent", async () => {
    const t = setup();
    expect((await t.request("/thoughts/root/contributions", { method: "POST", actor: "ai", body: thoughtInput })).status).toBe(403);
    expect((await t.request("/thoughts/child/developments", { method: "POST", body: thoughtInput })).status).toBe(403);
    expect((await t.request("/thoughts/root/title", { method: "PUT", actor: "none", body: { title: "x" } })).status).toBe(401);
    expect(t.createdThoughts).toEqual([]);
    const contribution = await t.request("/thoughts/root/contributions", { method: "POST", body: thoughtInput });
    expect(contribution.status).toBe(201);
    expect(await contribution.json()).toEqual({ ...thoughtInput, id: "generated-1", title: null, titleAuthor: null, author: "user", kind: "user-contribution", createdAt: "2030-01-02T03:04:05.000Z", origin: "contribution", parentId: "root", sourceIds: [] });
  });

  test("reads a tree and separate connections through scoped domain results", async () => {
    const t = setup();
    const all = await t.request("/thoughts");
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual(t.rejection.listThoughts({ actor: "user", mode: "normal" }));
    const child = await t.request("/thoughts/child");
    expect(child.status).toBe(200);
    expect(await child.json()).toEqual(t.rejection.listThoughts({ actor: "user", mode: "normal" }).find(item => item.id === "child"));
    expect(await (await t.request("/connections")).json()).toEqual(t.rejection.listConnections({ actor: "user", mode: "normal" }));
    expect(await (await t.request("/connections/cross")).json()).toEqual(t.rejection.listConnections({ actor: "user", mode: "normal" })[0]);
    expect(await (await t.request("/responses/child-response")).json()).toEqual(t.rejection.getResponse({ actor: "user", mode: "normal" }, "child-response"));
    for (const path of ["/thoughts/missing", "/connections/missing", "/responses/missing"]) expect((await t.request(path)).status).toBe(404);
  });

  test("rejected content and provenance are visible only in explicit user inspection scopes", async () => {
    const t = setup();
    t.rejection.rejectThought("user", "root");
    t.rejection.rejectConnection("user", "within");
    for (const mode of ["history", "show-rejected"] as const) {
      const thoughts = await t.request(`/thoughts?scope=${mode}`);
      expect(thoughts.status).toBe(200);
      expect(await thoughts.json()).toEqual(t.repo.snapshot().thoughts.map(item => ({ ...item, rejected: item.id === "root" })));
      const connections = await t.request(`/connections?scope=${mode}`);
      expect(connections.status).toBe(200);
      expect(await connections.json()).toEqual(t.repo.snapshot().connections.map(item => ({ ...item, rejected: item.id === "within" })));
      const response = await t.request(`/responses/root-response?scope=${mode}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(t.rejection.getResponse({ actor: "user", mode }, "root-response"));
    }
    for (const path of ["/thoughts/root", "/connections/within", "/responses/root-response"]) {
      expect((await t.request(path, { actor: "ai" })).status).toBe(404);
      expect((await t.request(`${path}?scope=history`)).status).toBe(200);
      expect((await t.request(`${path}?scope=show-rejected`, { actor: "ai" })).status).toBe(403);
    }
    const child = await (await t.request("/thoughts/child", { actor: "ai" })).json();
    expect(child.parentId).toBeNull();
    expect(child.sourceIds).toEqual(["outside"]);
    const crossResponse = await t.request("/connections/cross", { actor: "ai" });
    expect(crossResponse.status).toBe(200);
    const cross = await crossResponse.json();
    expect(cross.sourceIds).toEqual(["outside"]);
    for (const path of ["/thoughts", "/connections", "/responses/child-response"]) {
      expect((await t.request(`${path}?scope=history`, { actor: "ai" })).status).toBe(403);
      expect((await t.request(`${path}?scope=invalid`)).status).toBe(400);
      expect((await t.request(`${path}?scope=normal&scope=history`)).status).toBe(400);
    }
  });

  test("relationship reads gate the target, return direct children and incident directed connections", async () => {
    const t = setup();
    const snapshot = t.repo.snapshot();
    const get = async (path: string) => {
      const response = await t.request(path);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await get("/thoughts/root/children")).toEqual(snapshot.thoughts.filter(item => item.parentId === "root"));
    expect(await get("/thoughts/child/children")).toEqual(snapshot.thoughts.filter(item => item.parentId === "child"));
    expect(await get("/thoughts/outside/children")).toEqual([]);
    expect(await get("/thoughts/child/connections")).toEqual(snapshot.connections);
    expect(await get("/thoughts/outside/connections")).toEqual(snapshot.connections.filter(item => item.id === "cross"));
    expect(await get("/thoughts/root/connections")).toEqual([]);
    expect(await get("/thoughts/outside/responses")).toEqual([]);
    t.rejection.rejectThought("user", "root");
    const aiConnections = await t.request("/thoughts/outside/connections", { actor: "ai" });
    expect(aiConnections.status).toBe(200);
    expect(await aiConnections.json()).toEqual(snapshot.connections.filter(item => item.id === "cross").map(item => ({ ...item, sourceIds: ["outside"] })));
    for (const relation of ["children", "connections", "responses"]) {
      for (const id of ["missing", "root"]) {
        expect((await t.request(`/thoughts/${id}/${relation}`)).status).toBe(404);
        expect((await t.request(`/thoughts/${id}/${relation}`, { actor: "ai" })).status).toBe(404);
      }
      expect((await t.request(`/thoughts/root/${relation}?scope=history`)).status).toBe(200);
      expect((await t.request(`/thoughts/child/${relation}?scope=history`, { actor: "ai" })).status).toBe(403);
      expect((await t.request(`/thoughts/child/${relation}?scope=show-rejected`, { actor: "ai" })).status).toBe(403);
      expect((await t.request(`/thoughts/child/${relation}?scope=invalid`)).status).toBe(400);
      expect((await t.request(`/thoughts/child/${relation}?scope=normal&scope=history`)).status).toBe(400);
      expect((await t.request(`/thoughts/child/${relation}?other=x`)).status).toBe(400);
    }
  });

  test("response reverse discovery preserves shared order, fallback associations and scope privacy", async () => {
    const base = new MemoryRepository().snapshot().thoughts[1];
    if (!base) throw new Error("missing child fixture");
    const contribution: Thought = { ...base, id: "contribution", parentId: "root", author: "user", kind: "user-contribution", origin: "contribution", sourceIds: [] };
    const shared = { id: "shared", text: "shared addendum", role: "addendum", state: "complete", thoughtIds: ["sibling", "child", "grandchild"] } as const;
    const fallback = { id: "fallback", text: "fallback on contribution", role: "fallback", state: "interrupted", thoughtIds: ["contribution"] } as const;
    const t = setup(false, { thoughts: [contribution], responses: [shared, fallback] });
    const read = async (id: string, suffix = "", actor: "user" | "ai" = "user") => {
      const response = await t.request(`/thoughts/${id}/responses${suffix}`, { actor });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await read("sibling")).toEqual([shared]);
    expect(await read("grandchild")).toEqual([shared]);
    expect(await read("contribution")).toEqual([fallback]);
    t.rejection.rejectThought("user", "child");
    expect(await read("sibling")).toEqual([{ ...shared, thoughtIds: ["sibling", "grandchild"] }]);
    expect(await read("sibling", "", "ai")).toEqual([]);
    expect(await read("sibling", "?scope=history")).toEqual([shared]);
    expect(await read("child", "?scope=show-rejected")).toEqual([t.repo.snapshot().responses.find(item => item.id === "child-response"), shared]);
    expect(await read("contribution", "", "ai")).toEqual([fallback]);
    expect(t.repo.snapshot().responses.find(item => item.id === "shared")).toEqual(shared);
  });

  test("inspection flags describe explicit rejection without mutating canonical records or leaking into normal reads", async () => {
    const t = setup();
    const canonical = t.repo.snapshot();
    t.rejection.rejectThought("user", "root");
    t.rejection.rejectThought("user", "grandchild");
    t.rejection.rejectConnection("user", "cross");
    for (const mode of ["history", "show-rejected"]) {
      const suffix = `?scope=${mode}`;
      const thought = canonical.thoughts.find(item => item.id === "root");
      const grandchild = canonical.thoughts.find(item => item.id === "grandchild");
      const child = canonical.thoughts.find(item => item.id === "child");
      const cross = canonical.connections.find(item => item.id === "cross");
      const within = canonical.connections.find(item => item.id === "within");
      expect(await (await t.request(`/thoughts/root${suffix}`)).json()).toEqual({ ...thought, rejected: true });
      expect(await (await t.request(`/thoughts/child${suffix}`)).json()).toEqual({ ...child, rejected: false });
      expect(await (await t.request(`/thoughts/child/children${suffix}`)).json()).toEqual([{ ...grandchild, rejected: true }]);
      expect(await (await t.request(`/connections/cross${suffix}`)).json()).toEqual({ ...cross, rejected: true });
      expect(await (await t.request(`/connections/within${suffix}`)).json()).toEqual({ ...within, rejected: false });
      expect(await (await t.request(`/thoughts/child/connections${suffix}`)).json()).toEqual([{ ...cross, rejected: true }, { ...within, rejected: false }]);
    }
    expect(await (await t.request("/thoughts/child/connections")).json()).toEqual([]);
    const aiChild = await (await t.request("/thoughts/child", { actor: "ai" })).json();
    expect(aiChild).toEqual({ ...canonical.thoughts.find(item => item.id === "child"), parentId: null, sourceIds: ["outside"] });
    expect(await (await t.request("/thoughts/child/children", { actor: "ai" })).json()).toEqual([]);
    expect(await (await t.request("/thoughts/child/connections", { actor: "ai" })).json()).toEqual([]);
    expect(await (await t.request("/thoughts/child")).json()).toEqual(canonical.thoughts.find(item => item.id === "child"));
    expect(t.repo.snapshot().thoughts).toEqual(canonical.thoughts);
    expect(t.repo.snapshot().connections).toEqual(canonical.connections);
  });

  test("authentication and privilege checks precede all writes", async () => {
    const t = setup();
    for (const actor of ["none", "bad"] as const) {
      expect((await t.request("/thoughts", { actor, method: "POST", body: thoughtInput })).status).toBe(401);
      expect((await t.request("/thoughts", { actor })).status).toBe(401);
    }
    for (const path of ["/thoughts/root/reject", "/thoughts/root/restore", "/thoughts/root/branch/reject", "/thoughts/root/branch/restore", "/connections/cross/reject", "/connections/cross/restore"]) {
      expect((await t.request(path, { actor: "ai", method: "POST", body: {}, headers: { "x-role": "user" } })).status).toBe(403);
    }
    expect((await t.request("/thoughts/root/branch/preview", { actor: "ai" })).status).toBe(403);
    expect(t.repo.snapshot().rejectedThoughtIds).toEqual([]);
    expect(t.repo.snapshot().rejectedConnectionIds).toEqual([]);
    expect(t.createdThoughts).toEqual([]);
  });

  test("AI cannot reference rejected material on either write path", async () => {
    const t = setup();
    t.rejection.rejectThought("user", "root");
    const allowedThought = { ...thoughtInput, sourceIds: ["outside"] };
    const allowedConnection = { ...connectionInput, fromId: "child", sourceIds: ["outside"] };
    const thoughtResponse = await t.request("/thoughts/child/developments", { actor: "ai", method: "POST", body: allowedThought });
    expect(thoughtResponse.status).toBe(201);
    expect(await thoughtResponse.json()).toEqual({ ...allowedThought, id: "generated-1", title: null, titleAuthor: null, author: "ai", kind: "developing-idea", createdAt: "2030-01-02T03:04:05.000Z", origin: "development", parentId: "child" });
    const connectionResponse = await t.request("/connections", { actor: "ai", method: "POST", body: allowedConnection });
    expect(connectionResponse.status).toBe(201);
    expect(await connectionResponse.json()).toEqual({ ...allowedConnection, id: "generated-2", proposedBy: "ai" });
    expect((await t.request("/thoughts/root/developments", { actor: "ai", method: "POST", body: thoughtInput })).status).toBe(404);
    expect((await t.request("/thoughts/child/developments", { actor: "ai", method: "POST", body: { ...thoughtInput, sourceIds: ["root"] } })).status).toBe(404);
    for (const body of [connectionInput, { ...connectionInput, fromId: "outside", toId: "child", sourceIds: ["root"] }]) {
      expect((await t.request("/connections", { actor: "ai", method: "POST", body })).status).toBe(404);
    }
    expect(t.createdThoughts).toHaveLength(1);
    expect(t.createdConnections).toHaveLength(1);
  });

  test("single and branch state changes use exact current preview confirmation", async () => {
    const t = setup();
    expect((await t.request("/thoughts/child/reject", { method: "POST" })).status).toBe(204);
    const previewResponse = await t.request("/thoughts/root/branch/preview");
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toEqual(t.rejection.previewBranch("user", "root"));
    expect(preview.count).toBe(3);
    for (const body of [{ ...preview, count: 99 }, { ...preview, branchIds: ["root"] }, { ...preview, affectedIds: ["root"] }, { ...preview, rootId: "outside" }]) {
      expect((await t.request("/thoughts/root/branch/reject", { method: "POST", body })).status).toBe(409);
    }
    expect((await t.request("/thoughts/root/restore", { method: "POST" })).status).toBe(204);
    t.rejection.rejectThought("user", "sibling");
    expect((await t.request("/thoughts/root/branch/reject", { method: "POST", body: preview })).status).toBe(409);
    const current = await (await t.request("/thoughts/root/branch/preview")).json();
    expect((await t.request("/thoughts/root/branch/reject", { method: "POST", body: current })).status).toBe(204);
    expect([...t.repo.snapshot().rejectedThoughtIds].sort()).toEqual(["child", "grandchild", "root", "sibling"]);
    expect((await t.request("/thoughts/root/branch/restore", { method: "POST" })).status).toBe(204);
    expect(t.repo.snapshot().rejectedThoughtIds).toEqual([]);
    expect((await t.request("/connections/cross/reject", { method: "POST" })).status).toBe(204);
    expect((await t.request("/connections/cross/restore", { method: "POST" })).status).toBe(204);
    expect((await t.request("/thoughts/missing/reject", { method: "POST" })).status).toBe(404);
  });

  test("malformed requests, spoofed internals and missing references fail before writes", async () => {
    const t = setup();
    expect((await t.request("/thoughts", { method: "POST", raw: "{" })).status).toBe(400);
    expect((await t.request("/thoughts", { method: "POST", body: { ...thoughtInput, text: 7 } })).status).toBe(400);
    expect((await t.request("/connections", { method: "POST", body: { ...connectionInput, sourceIds: "root" } })).status).toBe(400);
    expect((await t.request("/thoughts/missing/contributions", { method: "POST", body: thoughtInput })).status).toBe(404);
    expect((await t.request("/connections", { method: "POST", body: { ...connectionInput, toId: "missing" } })).status).toBe(404);
    for (const field of ["id", "createdAt", "author", "kind", "origin", "parentId"]) expect((await t.request("/thoughts", { method: "POST", body: { ...thoughtInput, [field]: "spoof" } })).status).toBe(400);
    expect((await t.request("/connections", { method: "POST", body: { ...connectionInput, id: "cross" } })).status).toBe(400);
    expect(t.createdThoughts).toEqual([]);
    expect(t.createdConnections).toEqual([]);
  });

  test("boundary attempts and outcomes omit credentials, content and internal error details", async () => {
    const t = setup();
    const response = await t.request("/thoughts", { method: "POST", body: { ...thoughtInput, kind: 3 }, headers: { origin: "https://browser.example" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const serialized = JSON.stringify([await response.text(), t.events]);
    for (const secret of [credentials.user, credentials.ai, thoughtInput.text, "SQL", "sqlite"]) expect(serialized).not.toContain(secret);
    expect(t.events.some(event => event.phase === "attempt" && event.method === "POST")).toBe(true);
    expect(t.events.some(event => event.phase === "outcome" && event.status === 400)).toBe(true);
    const preflight = await t.request("/thoughts", { method: "OPTIONS", headers: { origin: "https://browser.example", "access-control-request-method": "POST" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("unexpected write failures are sanitized and logged as outcomes", async () => {
    const t = setup(true);
    const response = await t.request("/thoughts", { method: "POST", body: thoughtInput });
    expect(response.status).toBe(500);
    const output = JSON.stringify([await response.text(), t.events]);
    for (const value of ["SQL", "secret internal failure", thoughtInput.text, credentials.user]) expect(output).not.toContain(value);
    expect(t.events.some(event => event.phase === "attempt")).toBe(true);
    expect(t.events.some(event => event.phase === "outcome" && event.status === 500)).toBe(true);
  });
});
