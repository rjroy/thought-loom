export function firstParameter(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function searchHref(query: string): string {
  return query ? `/search?q=${encodeURIComponent(query)}` : "/search";
}

export function inquiryHref(sourceId: string, query = "", itemId?: string, versionId?: string): string {
  const parameters = new URLSearchParams();
  if (query) parameters.set("q", query);
  if (itemId) parameters.set("item", itemId);
  if (itemId && versionId) parameters.set("version", versionId);
  return `/sources/${encodeURIComponent(sourceId)}/inquiry${parameters.size ? `?${parameters}` : ""}${itemId && versionId ? "#discussion-target" : itemId ? `#item-${encodeURIComponent(itemId)}` : ""}`;
}

export function readableDate(value: string): string {
  return `${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))} UTC`;
}

export function sourceHref(id: string, query = ""): string {
  return `/sources/${encodeURIComponent(id)}${query ? `?q=${encodeURIComponent(query)}` : ""}`;
}

export function discussionHref(root: string, dialogue: string, query = "", turnId?: string): string {
  const parameters = new URLSearchParams();
  if (query) parameters.set("q", query);
  parameters.set("dialogue", dialogue);
  return `/sources/${encodeURIComponent(root)}/inquiry?${parameters}#${turnId ? `turn-${encodeURIComponent(turnId)}` : "development"}`;
}
