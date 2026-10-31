// Admission includes native prompt hooks and durable enqueue, not generation.
// Keep its budget separate from ordinary metadata/read requests.
export const DEFAULT_ADMISSION_TIMEOUT_MS = 15_000;
export const ADMISSION_SETTLEMENT_MARGIN_MS = 10_000;
export const MIN_ADMISSION_LEASE_MS = 30_000;

export function parseAdmissionTimeoutMs(value: unknown): number | null {
  if (value === undefined) return DEFAULT_ADMISSION_TIMEOUT_MS;
  return typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 120_000 ? value : null;
}
