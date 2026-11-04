import type { DaemonRequest } from "./daemon";
import type { IdeaThought } from "../features/idea/types";
import { command, connection, preview, sharedResponse, thought } from "../features/idea/validation";

export interface IdeaDependencies { readonly callDaemon: (request: DaemonRequest) => Promise<Response>; }
const headers = { "cache-control": "private, no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const problem = (status: number) => json({ message: status === 400 ? "Invalid request." : status === 404 ? "Idea unavailable." : "Unable to confirm the outcome." }, status);
const safeId = (id: string) => /^[A-Za-z0-9_~.-]+$/.test(id) && id !== "." && id !== "..";

/** Testable cores; production route owns server-only credentials and request guard. */
export async function handleIdeaRead(request: Request, id: string, deps: IdeaDependencies): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (!safeId(id) || [...params.keys()].some(key => !["scope", "part", "responseId"].includes(key))
      || ["scope", "part", "responseId"].some(key => params.getAll(key).length > 1)) return problem(400);
  const scope = params.get("scope") ?? "normal", part = params.get("part") ?? "view";
  if ((scope !== "normal" && scope !== "history" && scope !== "show-rejected")
      || (part !== "view" && part !== "sources" && part !== "history" && part !== "preview")
      || (params.has("responseId") && (part !== "view" || !params.get("responseId")?.trim()))) return problem(400);
  const path = `/thoughts/${encodeURIComponent(id)}`;
  const suffix = `?scope=${scope}`;
  const get = (target: string) => deps.callDaemon({ method: "GET", path: target });
  try {
    if (part === "preview") {
      const response = await get(`${path}/branch/preview`);
      if (response.status === 404) return problem(404);
      if (response.status !== 200) return problem(502);
      const value: unknown = await response.json();
      return preview(value, id) ? json(value) : problem(502);
    }
    const focus = await get(path + suffix);
    if (focus.status === 404) return problem(404);
    if (focus.status !== 200) return problem(502);
    const root: unknown = await focus.json();
    if (!thought(root) || root.id !== id) return problem(502);
    const cache = new Map<string, Promise<IdeaThought | null>>();
    cache.set(id, Promise.resolve(root));
    const fetchThought = (target: string): Promise<IdeaThought | null> => {
      const cached = cache.get(target);
      if (cached) return cached;
      const pending = (async () => {
        if (!safeId(target)) return null;
        try {
          const res = await get(`/thoughts/${encodeURIComponent(target)}${suffix}`);
          if (res.status !== 200) return null;
          const data: unknown = await res.json();
          return thought(data) && data.id === target ? data : null;
        } catch { return null; }
      })();
      cache.set(target, pending);
      return pending;
    };
    const resolveMany = async (ids: readonly string[]) => {
      let index = 0;
      const unique = [...new Set(ids)];
      async function worker() { while (index < unique.length) { const target = unique[index++]; if (target !== undefined) await fetchThought(target); } }
      await Promise.all(Array.from({ length: Math.min(4, unique.length) }, () => worker()));
    };
    if (part === "sources") {
      await resolveMany(root.sourceIds);
      return json({ sources: await Promise.all(root.sourceIds.map(async sourceId => ({ id: sourceId, thought: await fetchThought(sourceId) }))) });
    }
    if (part === "history") {
      const childrenResponse = await get(`${path}/children${suffix}`);
      if (childrenResponse.status !== 200) return problem(502);
      const children: unknown = await childrenResponse.json();
      if (!Array.isArray(children) || !children.every(item => thought(item) && item.parentId === id)) return problem(502);
      const ancestors: IdeaThought[] = [], visited = new Set([id]);
      let parentId = root.parentId;
      while (parentId && !visited.has(parentId) && visited.size < 1000) {
        visited.add(parentId);
        const parent = await fetchThought(parentId);
        if (!parent) break;
        ancestors.push(parent); parentId = parent.parentId;
      }
      return json({ ancestors, children, unavailableParentId: parentId });
    }
    const [edgeResponse, responseResponse] = await Promise.all([get(`${path}/connections${suffix}`), get(`${path}/responses${suffix}`)]);
    if (edgeResponse.status !== 200 || responseResponse.status !== 200) return problem(502);
    const edges: unknown = await edgeResponse.json(), replies: unknown = await responseResponse.json();
    if (!Array.isArray(edges) || !edges.every(edge => connection(edge) && (edge.fromId === id || edge.toId === id))
        || !Array.isArray(replies) || !replies.every(reply => sharedResponse(reply) && reply.thoughtIds.includes(id))) return problem(502);
    const neighbors = edges.map(edge => edge.fromId === id ? edge.toId : edge.fromId);
    await resolveMany(neighbors);
    const connections = await Promise.all(edges.map(async (edge, i) => ({ connection: edge, thought: await fetchThought(neighbors[i]) })));
    const focusedResponse = replies.find(reply => reply.id === params.get("responseId")) ?? null;
    return json({ thought: root, connections, responses: replies, focusedResponse });
  } catch { return problem(502); }
}

export async function handleIdeaCommand(request: Request, id: string, deps: IdeaDependencies): Promise<Response> {
  if (!safeId(id) || new URL(request.url).search) return problem(400);
  let input: unknown;
  try { input = await request.json(); } catch { return problem(400); }
  if (!command(input, id)) return problem(400);
  const base = `/thoughts/${encodeURIComponent(id)}`;
  let operation: DaemonRequest;
  switch (input.action) {
    case "title": operation = { method: "PUT", path: `${base}/title`, body: JSON.stringify({ title: input.title }) }; break;
    case "reject-thought": case "restore-thought": operation = { method: "POST", path: `${base}/${input.action === "reject-thought" ? "reject" : "restore"}` }; break;
    case "restore-branch": operation = { method: "POST", path: `${base}/branch/restore` }; break;
    case "reject-branch": operation = { method: "POST", path: `${base}/branch/reject`, body: JSON.stringify(input.preview) }; break;
    case "reject-connection": case "restore-connection":
      if (!safeId(input.connectionId)) return problem(400);
      operation = { method: "POST", path: `/connections/${encodeURIComponent(input.connectionId)}/${input.action === "reject-connection" ? "reject" : "restore"}` }; break;
  }
  try {
    const response = await deps.callDaemon(operation);
    if ([400, 401, 403, 404].includes(response.status)) return problem(response.status);
    if (response.status === 409 && input.action === "reject-branch") return problem(409);
    if (input.action === "title" && response.status === 200) {
      const value: unknown = await response.json();
      return thought(value) && value.id === id && value.title === input.title
        && value.titleAuthor === (input.title === null ? null : "user") ? json(value) : problem(502);
    }
    if (input.action !== "title" && response.status === 204) return new Response(null, { status: 204, headers });
    return problem(502);
  } catch { return problem(502); }
}
