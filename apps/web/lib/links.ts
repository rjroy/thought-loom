export function firstParameter(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function searchHref(query: string): string {
  return query ? `/search?q=${encodeURIComponent(query)}` : "/search";
}

export function inquiryHref(sourceId: string, query = "", itemId?: string): string {
  const parameters = new URLSearchParams();
  if (query) parameters.set("q", query);
  if (itemId) parameters.set("item", itemId);
  return `/sources/${encodeURIComponent(sourceId)}/inquiry${parameters.size ? `?${parameters}` : ""}${itemId ? `#item-${encodeURIComponent(itemId)}` : ""}`;
}

export function readableDate(value: string): string {
  return `${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))} UTC`;
}
