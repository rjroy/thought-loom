import { describe, expect, test } from "bun:test";
import { createApp, type BoundaryEvent } from "../src/daemon/app";
import { CreationService } from "../src/domain/creation";
import { ForbiddenActorError, RejectionService, type RejectionRepository, type RejectionSnapshot, type RejectionTransaction } from "../src/domain/rejection";
import { SimpleExportNotFoundError, SimpleExportService, type SimpleExportRequest } from "../src/domain/simple-export";
import type { Thought } from "../src/domain/thought";
import { TitleService } from "../src/domain/title";
import { ValidationError } from "../src/domain/validation";

function note(id: string, parentId: string | null, author: "user" | "ai", text: string, title: string | null, createdAt: string): Thought {
  return { id, parentId, author, text, title, titleAuthor: title === null ? null : author, createdAt, kind: "developing-idea", origin: "fixture", sourceIds: [] };
}
const thoughts: Thought[] = [
  note("source-root", null, "user", "Root original recorded wording", "Current human label", "2030-01-01"),
  note("source-a", "source-root", "user", "First branch wording", null, "2030-01-02"),
  note("source-b", "source-root", "ai", "Second branch wording", null, "2030-01-03"),
  note("source-a1", "source-a", "ai", "Fallback thought response is retained", null, "2030-01-04"),
  note("source-b1", "source-b", "user", "Second branch child wording", null, "2030-01-05"),
  note("source-hidden", "source-a1", "user", "Rejected private node wording", null, "2030-01-06"),
  note("source-beyond", "source-hidden", "ai", "Active beyond rejected node wording", null, "2030-01-07"),
  note("source-outside", null, "user", "Connected but outside evolution tree", null, "2030-01-08"),
];

class FixtureRepository implements RejectionRepository {
  private rejectedThoughtIds = new Set(["source-hidden"]);
  snapshot(): RejectionSnapshot {
    return {
      thoughts,
      connections: [{ id: "crosslink", fromId: "source-root", toId: "source-outside", category: "related", proposedBy: "ai", explanation: "external connection secret", sourceIds: [] }],
      responses: [
        { id: "addendum", text: "Private full addendum not exported", role: "addendum", state: "complete", thoughtIds: ["source-b"] },
        { id: "fallback", text: "Fallback thought response is retained", role: "fallback", state: "complete", thoughtIds: ["source-a1"] },
      ],
      rejectedThoughtIds: [...this.rejectedThoughtIds], rejectedConnectionIds: [],
    };
  }
  transaction<T>(action: (tx: RejectionTransaction) => T): T {
    return action({ snapshot: () => this.snapshot(), setThoughtRejected: (id, rejected) => { if (rejected) this.rejectedThoughtIds.add(id); else this.rejectedThoughtIds.delete(id); }, setConnectionRejected: () => { throw new Error("Unexpected connection write"); } });
  }
}

function fixture() {
  const repo = new FixtureRepository();
  const rejection = new RejectionService(repo);
  const service = new SimpleExportService(rejection);
  return { repo, rejection, service };
}
const request = (count: number, traversal: "breadth" | "depth"): SimpleExportRequest => ({ rootId: "source-root", count, traversal });

describe("Simple Markdown export", () => {
  test("breadth and depth apply the count to active evolution thoughts, not links or rejected nodes", () => {
    const { repo, service } = fixture();
    const before = JSON.stringify(repo.snapshot());
    const breadth = service.render("user", request(4, "breadth"));
    const depth = service.render("user", request(4, "depth"));
    for (const result of [breadth, depth]) {
      expect(result).toContain("Root original recorded wording");
      expect(result).not.toContain("Rejected private node wording");
      expect(result).not.toContain("Connected but outside evolution tree");
      expect(result).not.toContain("external connection secret");
      expect(result).not.toContain("Private full addendum not exported");
      expect(thoughts.filter(item => item.id !== "source-hidden" && item.id !== "source-outside" && result.includes(item.text))).toHaveLength(4);
    }
    const breadthA = breadth.indexOf("First branch wording");
    const breadthB = breadth.indexOf("Second branch wording");
    expect(breadthA).toBeGreaterThan(-1);
    expect(breadthB).toBeGreaterThan(-1);
    const breadthGrandchildren = [breadth.indexOf("Fallback thought response is retained"), breadth.indexOf("Second branch child wording")].filter(index => index >= 0);
    expect(breadthGrandchildren).toHaveLength(1);
    expect(breadthGrandchildren[0]).toBeGreaterThan(Math.max(breadthA, breadthB));
    const depthGrandchildren = [depth.indexOf("Fallback thought response is retained"), depth.indexOf("Second branch child wording")].filter(index => index >= 0);
    expect(depthGrandchildren.length).toBeGreaterThan(0);
    const firstGrandchild = Math.min(...depthGrandchildren);
    const branchIndexes = [depth.indexOf("First branch wording"), depth.indexOf("Second branch wording")].filter(index => index >= 0);
    expect(branchIndexes.length).toBeGreaterThan(0);
    expect(firstGrandchild).toBeGreaterThan(-1);
    if (branchIndexes.length === 2) expect(firstGrandchild).toBeLessThan(Math.max(...branchIndexes));
    const all = service.render("user", request(99, "breadth"));
    expect(all).toContain("Active beyond rejected node wording");
    expect(all).toContain("Fallback thought response is retained");
    expect(all).not.toContain("Rejected private node wording");
    for (const item of thoughts.filter(item => item.id !== "source-hidden" && item.id !== "source-outside")) expect(all).toContain(item.id);
    expect(JSON.stringify(repo.snapshot())).toBe(before);
  });

  test("root-only export includes current title, source identity and attribution without changing stored data", () => {
    const { repo, service } = fixture();
    const before = JSON.stringify(repo.snapshot());
    const markdown = service.render("user", request(1, "breadth"));
    expect(markdown).toContain("Current human label");
    expect(markdown).toContain("source-root");
    expect(markdown).toContain("Root original recorded wording");
    expect(markdown).toMatch(/user/i);
    expect(markdown).not.toContain("First branch wording");
    const whole = service.render("user", request(99, "depth"));
    expect(whole).toContain("source-b");
    expect(whole).toMatch(/\bai\b/i);
    expect(whole).toContain("Fallback thought response is retained");
    expect(whole).toContain("First branch wording");
    expect(JSON.stringify(repo.snapshot())).toBe(before);
  });

  test("invalid requests, invisible roots and AI actors fail with specific domain errors", () => {
    const { repo, rejection, service } = fixture();
    const before = JSON.stringify(repo.snapshot());
    for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => service.render("user", request(count, "depth"))).toThrow(ValidationError);
    expect(() => service.render("user", { ...request(1, "depth"), rootId: "" })).toThrow(ValidationError);
    expect(() => service.render("user", { ...request(1, "depth"), traversal: "sideways" } as unknown as SimpleExportRequest)).toThrow(ValidationError);
    expect(() => service.render("user", { ...request(1, "depth"), rootId: "missing" })).toThrow(SimpleExportNotFoundError);
    expect(() => service.render("user", { ...request(1, "depth"), rootId: "source-hidden" })).toThrow(SimpleExportNotFoundError);
    expect(() => service.render("ai", request(1, "depth"))).toThrow(ForbiddenActorError);
    expect(JSON.stringify(repo.snapshot())).toBe(before);
    rejection.restoreThought("user", "source-hidden");
    expect(service.render("user", { rootId: "source-hidden", count: 1, traversal: "depth" })).toContain("Rejected private node wording");
  });
});

describe("Simple export HTTP boundary", () => {
  test("POST /exports/simple authenticates, returns Markdown and rejects invalid requests", async () => {
    const { repo, rejection, service } = fixture();
    const events: BoundaryEvent[] = [];
    const creation = new CreationService({ rejection, id: () => "unused", now: () => "2030", writes: { createThought: () => { throw new Error("Unexpected write"); }, createConnection: () => { throw new Error("Unexpected write"); } } });
    const titles = new TitleService({ transaction: () => { throw new Error("Unexpected title operation"); } });
    const credentials = { user: "fixture-user-secret", ai: "fixture-ai-secret" };
    const app = createApp({ rejection, creation, titles, simpleExport: service, credentials, logger: event => events.push(event) });
    const call = (body: unknown, actor: "user" | "ai" | "none" = "user", path = "/exports/simple") => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(actor === "none" ? {} : { authorization: `Bearer ${credentials[actor]}` }) }, body: JSON.stringify(body) });
    const before = JSON.stringify(repo.snapshot());
    const response = await call(request(1, "breadth"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/markdown\b/i);
    const markdown = await response.text();
    expect(markdown).toContain("Root original recorded wording");
    expect(markdown).toContain("source-root");
    expect((await call(request(1, "breadth"), "none")).status).toBe(401);
    expect((await call(request(1, "breadth"), "ai")).status).toBe(403);
    expect((await call({ ...request(1, "breadth"), rootId: "missing" })).status).toBe(404);
    expect((await call({ ...request(1, "breadth"), rootId: "source-hidden" })).status).toBe(404);
    for (const body of [{}, { ...request(0, "breadth") }, { ...request(-1, "breadth") }, { ...request(1.5, "breadth") }, { ...request(1, "breadth"), traversal: "other" }, { ...request(1, "breadth"), rootId: "" }, { ...request(1, "breadth"), actor: "user" }]) expect((await call(body)).status).toBe(400);
    expect((await call(request(1, "breadth"), "user", "/exports/simple?scope=history")).status).toBe(400);
    expect((await app.request("/exports/simple", { method: "POST", headers: { authorization: `Bearer ${credentials.user}`, "content-type": "application/json" }, body: "{" })).status).toBe(400);
    expect(JSON.stringify(repo.snapshot())).toBe(before);
    const logs = JSON.stringify(events);
    expect(logs).not.toContain(credentials.user);
    expect(logs).not.toContain("Root original recorded wording");
    expect(events.some(event => event.phase === "attempt" && event.method === "POST")).toBe(true);
    expect(events.some(event => event.phase === "outcome" && event.status === 200)).toBe(true);
  });
});
