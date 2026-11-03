import { describe, expect, test } from "bun:test";
import { createApp, type BoundaryEvent, type CreationPort } from "../src/daemon/app";
import { RejectionService } from "../src/domain/rejection";
import type { Thought } from "../src/domain/thought";
import type { Connection } from "../src/domain/connection";
import { MemoryRepository } from "./rejection-fixtures";

// Contract: bare JSON records/arrays; ?scope=normal|history|show-rejected.
// POST /thoughts, /connections; GET collections and /:id; GET /responses/:id.
// POST /thoughts/:id/{reject,restore}, /connections/:id/{reject,restore};
// GET /thoughts/:id/branch/preview; POST /thoughts/:id/branch/{reject,restore}.
// Branch reject body is the exact preview, including rootId, branchIds, affectedIds and count.
const credentials = { user: "user-secret-token", ai: "ai-secret-token" };
const thoughtInput = { id: "new", text: "sensitive new text", title: null, kind: "developing-idea", createdAt: "2026-01-01T00:00:00Z", origin: "test", parentId: "root", sourceIds: ["outside"] } satisfies Omit<Thought, "author">;
const connectionInput = { id: "new-link", fromId: "root", toId: "outside", category: "supports", explanation: "sensitive rationale", sourceIds: ["child"] } satisfies Omit<Connection, "proposedBy">;

function setup(failWrites = false) {
  const repo = new MemoryRepository();
  const rejection = new RejectionService(repo);
  const createdThoughts: Thought[] = [];
  const createdConnections: Connection[] = [];
  const events: BoundaryEvent[] = [];
  const writes: CreationPort = {
    createThought: thought => { if (failWrites) throw new Error("SQL secret internal failure"); createdThoughts.push(thought); },
    createConnection: connection => { createdConnections.push(connection); },
  };
  const app = createApp({ rejection, writes, credentials, logger: event => events.push(event) });
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
  test("creates immutable domain values with identity from credentials, never request authorship", async () => {
    const t = setup();
    const result = await t.request("/thoughts", { method: "POST", actor: "ai", body: thoughtInput });
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ ...thoughtInput, author: "ai" });
    expect(t.createdThoughts).toEqual([{ ...thoughtInput, author: "ai" }]);
    expect(Object.isFrozen(t.createdThoughts[0])).toBe(true);
    const link = await t.request("/connections", { method: "POST", body: connectionInput });
    expect(link.status).toBe(201);
    expect(await link.json()).toEqual({ ...connectionInput, proposedBy: "user" });
    expect(Object.isFrozen(t.createdConnections[0])).toBe(true);
    expect((await t.request("/thoughts", { method: "POST", actor: "ai", body: { ...thoughtInput, author: "user" } })).status).toBe(400);
    expect((await t.request("/connections", { method: "POST", actor: "ai", body: { ...connectionInput, proposedBy: "user" } })).status).toBe(400);
    expect(t.createdThoughts).toHaveLength(1);
    expect(t.createdConnections).toHaveLength(1);
    expect((await t.request("/thoughts/root", { method: "PATCH", body: { text: "edit" } })).status).toBe(404);
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
      expect(await thoughts.json()).toEqual(t.rejection.listThoughts({ actor: "user", mode }));
      const connections = await t.request(`/connections?scope=${mode}`);
      expect(connections.status).toBe(200);
      expect(await connections.json()).toEqual(t.rejection.listConnections({ actor: "user", mode }));
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
    const allowedThought = { ...thoughtInput, parentId: "child", sourceIds: ["outside"] };
    const allowedConnection = { ...connectionInput, fromId: "child", sourceIds: ["outside"] };
    const thoughtResponse = await t.request("/thoughts", { actor: "ai", method: "POST", body: allowedThought });
    expect(thoughtResponse.status).toBe(201);
    expect(await thoughtResponse.json()).toEqual({ ...allowedThought, author: "ai" });
    const connectionResponse = await t.request("/connections", { actor: "ai", method: "POST", body: allowedConnection });
    expect(connectionResponse.status).toBe(201);
    expect(await connectionResponse.json()).toEqual({ ...allowedConnection, proposedBy: "ai" });
    for (const body of [{ ...thoughtInput, parentId: "root" }, { ...thoughtInput, parentId: null, sourceIds: ["root"] }]) {
      expect((await t.request("/thoughts", { actor: "ai", method: "POST", body })).status).toBe(404);
    }
    for (const body of [connectionInput, { ...connectionInput, fromId: "outside", toId: "child", sourceIds: ["root"] }]) {
      expect((await t.request("/connections", { actor: "ai", method: "POST", body })).status).toBe(404);
    }
    expect(t.createdThoughts).toEqual([{ ...allowedThought, author: "ai" }]);
    expect(t.createdConnections).toEqual([{ ...allowedConnection, proposedBy: "ai" }]);
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

  test("malformed requests, missing references and duplicate identifiers fail before writes", async () => {
    const t = setup();
    expect((await t.request("/thoughts", { method: "POST", raw: "{" })).status).toBe(400);
    expect((await t.request("/thoughts", { method: "POST", body: { ...thoughtInput, text: 7 } })).status).toBe(400);
    expect((await t.request("/connections", { method: "POST", body: { ...connectionInput, sourceIds: "root" } })).status).toBe(400);
    expect((await t.request("/thoughts", { method: "POST", body: { ...thoughtInput, parentId: "missing" } })).status).toBe(404);
    expect((await t.request("/connections", { method: "POST", body: { ...connectionInput, toId: "missing" } })).status).toBe(404);
    expect((await t.request("/thoughts", { method: "POST", body: { ...thoughtInput, id: "root" } })).status).toBe(409);
    expect((await t.request("/connections", { method: "POST", body: { ...connectionInput, id: "cross" } })).status).toBe(409);
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
