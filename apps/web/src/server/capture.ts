import type { DaemonRequest } from "./daemon";
import { captureReceipt } from "../features/capture/submission";

export interface CaptureDependencies {
  readonly callDaemon: (request: DaemonRequest) => Promise<Response>;
}

/** Testable core; the production route owns the server-only wrapper and request guard. */
export async function handleCapture(request: Request, deps: CaptureDependencies): Promise<Response> {
  const json = (body: unknown, status: number) => Response.json(body, {
    status, headers: { "cache-control": "private, no-store" },
  });
  const rejected = () => json({ message: "Your thought was not saved." }, 400);
  const uncertain = () => json({ message: "We could not confirm whether your thought was saved." }, 502);
  let input: unknown;
  try { input = await request.json(); } catch { return rejected(); }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return rejected();
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== "text" && key !== "title")
      || typeof data.text !== "string" || !data.text.trim()
      || (data.title !== undefined && data.title !== null && typeof data.title !== "string")) return rejected();
  const body = { text: data.text, ...(data.title !== undefined ? { title: data.title } : {}) };
  try {
    const response = await deps.callDaemon({ method: "POST", path: "/thoughts", body: JSON.stringify(body) });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return json({ message: "Your thought was not saved." }, response.status);
    }
    if (response.status !== 201) return uncertain();
    const receipt = captureReceipt(await response.json());
    return receipt ? json(receipt, 201) : uncertain();
  } catch {
    return uncertain();
  }
}
