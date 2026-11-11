export const exportHref = (id: string) => `/exports/${encodeURIComponent(id)}`;
export function exportDate(value: string) {
  return `${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(value))} UTC`;
}
