const safe = (id: string) => /^[A-Za-z0-9_~.-]+$/.test(id) && id !== "." && id !== "..";
export const searchEntryHref = "/explore/ask";
export const searchCatalogHref = "/explore/ask/saved";
export function searchSessionHref(id: string): string { if (!safe(id)) throw new Error("Invalid search identity"); return `/explore/ask/${id}`; }
export function searchHistoryHref(id: string): string { return `${searchSessionHref(id)}/history`; }
export function safeSearchReturn(value: string): boolean {
  if (/[\\#\x00-\x1f\x7f]/.test(value)) return false;
  return /^\/explore\/ask\/[A-Za-z0-9_~.-]+(?:\/history)?$/.test(value) && value.split("/").every(segment => segment !== "." && segment !== "..");
}
