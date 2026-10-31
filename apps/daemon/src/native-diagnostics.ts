export type NativeRequestStage = "operation" | "connectioncheck" | "ownershipcheck" | "commandload" |
  "admissionfence" | "promptrequest" | "acknowledgementvalidation" | "identityrequest" | "sessiongetrequest" | "interruptrequest";
export type NativeRequestDiagnostic = {
  stage: NativeRequestStage;
  elapsedMs: number;
  budgetMs?: number;
  requestAborted?: boolean;
  abortKind?: "none" | "deadline" | "lifetime" | "other";
};

type ErrorKind = "Error" | "ClientError" | "NativeAdapterError" | "AbortError" | "TimeoutError" | "TypeError" | "RangeError" | "other";
type SdkReason = "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse" | "SseEventTooLarge";
type ErrorMetadata = { errorKind: ErrorKind; causeKind?: ErrorKind; rootCauseKind?: ErrorKind; sdkReason?: SdkReason; httpStatus?: number };

// Inspect only named data properties. Never serialize an error or invoke its
// accessors: SDK messages/bodies and arbitrary dependency properties are private.
function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function errorKind(value: unknown): ErrorKind {
  const name = property(value, "name");
  if (name === "ClientError" || name === "NativeAdapterError" || name === "AbortError" || name === "TimeoutError" ||
      name === "TypeError" || name === "RangeError" || name === "Error") return name;
  if (value instanceof DOMException) return value.name === "TimeoutError" ? "TimeoutError" : value.name === "AbortError" ? "AbortError" : "other";
  if (value instanceof TypeError) return "TypeError";
  if (value instanceof RangeError) return "RangeError";
  return value instanceof Error ? "Error" : "other";
}
export function nativeErrorMetadata(error: unknown): ErrorMetadata {
  // An unusual dependency error (including a Proxy) must not break recovery
  // merely because its diagnostic shape cannot be inspected safely.
  try { return inspectError(error); } catch { return { errorKind: "other" }; }
}
function inspectError(error: unknown): ErrorMetadata {
  const result: ErrorMetadata = { errorKind: errorKind(error) };
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && !visited.has(current); depth++) {
    visited.add(current);
    if (depth === 1) result.causeKind = errorKind(current);
    if (depth > 0) result.rootCauseKind = errorKind(current);
    const reason = property(current, "reason");
    if (reason === "Transport" || reason === "UnexpectedStatus" || reason === "UnsupportedContentType" || reason === "MalformedResponse" || reason === "SseEventTooLarge") result.sdkReason ??= reason;
    const status = property(current, "status");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus ??= status;
    current = property(current, "cause");
  }
  return result;
}

export function requestAbortMetadata(signal: AbortSignal, deadline: AbortSignal, lifetime: AbortSignal): Pick<NativeRequestDiagnostic, "requestAborted" | "abortKind"> {
  return { requestAborted: signal.aborted, abortKind: !signal.aborted ? "none" :
    deadline.aborted && signal.reason === deadline.reason ? "deadline" :
    lifetime.aborted && signal.reason === lifetime.reason ? "lifetime" : "other" };
}

export function elapsedMilliseconds(start: number, now: number): number {
  const elapsed = now - start;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
}
