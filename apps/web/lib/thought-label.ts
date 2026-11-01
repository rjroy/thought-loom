// Display only: never turn a body excerpt into stored title metadata.
export function compactThoughtLabel(title: string | undefined, body: string): string {
  return title?.trim() ? title : body.trim().split(/\s+/u).slice(0, 5).join(" ");
}
