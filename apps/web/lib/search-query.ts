import { parseSearchParameters } from "@thoughtloom/contracts";

// Next page parameters can contain repeated values. Keep those intact so the
// shared request parser, rather than a first-value shortcut, validates them.
export function pageSearchRequest(parameters: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const name of ["q", "limit"]) {
    const value = parameters[name];
    for (const part of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, part);
  }
  return parseSearchParameters(query);
}
