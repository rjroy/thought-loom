export interface CaptureSnapshot {
  readonly text: string;
  readonly title?: string | null;
}

export interface CaptureReceipt {
  readonly id: string;
  readonly text: string;
  readonly title: string | null;
}

export type CaptureResult =
  | { readonly kind: "saved"; readonly receipt: CaptureReceipt }
  | { readonly kind: "not-saved"; readonly snapshot: CaptureSnapshot; readonly message: string }
  | { readonly kind: "uncertain"; readonly snapshot: CaptureSnapshot; readonly message: string };

export interface SubmissionDependencies {
  readonly fetch: typeof fetch;
}

/** Select only the canonical receipt fields; other daemon metadata stays server-side. */
export function captureReceipt(value: unknown): CaptureReceipt | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()
      || typeof record.text !== "string" || !record.text.trim()
      || !(typeof record.title === "string" || record.title === null)) return undefined;
  return { id: record.id, text: record.text, title: record.title };
}

/** Client-safe submission seam; UI owns pending and deliberate retry state. */
export async function submitCapture(snapshot: CaptureSnapshot, deps: SubmissionDependencies): Promise<CaptureResult> {
  const submitted: CaptureSnapshot = Object.freeze({
    text: snapshot.text,
    ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
  });
  const uncertain = (): CaptureResult => ({
    kind: "uncertain", snapshot: submitted, message: "We could not confirm whether your thought was saved.",
  });
  try {
    const response = await deps.fetch("/api/capture", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submitted),
      cache: "no-store", redirect: "error",
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { kind: "not-saved", snapshot: submitted, message: "Your thought was not saved." };
    }
    if (response.status !== 201) return uncertain();
    const receipt = captureReceipt(await response.json());
    return receipt ? { kind: "saved", receipt } : uncertain();
  } catch {
    return uncertain();
  }
}
