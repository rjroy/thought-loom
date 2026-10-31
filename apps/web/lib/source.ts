import { parseSourceRecord, type Source } from "@thoughtloom/contracts";

export function isSourceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSource(value: unknown): Source | null {
  const source = parseSourceRecord(value);
  return source && isSourceId(source.id) ? source : null;
}
