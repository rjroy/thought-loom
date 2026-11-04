export function evolveThoughtId(params: URLSearchParams): string | undefined {
  if ([...params.keys()].some(key => key !== "thoughtId") || params.getAll("thoughtId").length !== 1) return undefined;
  const id = params.get("thoughtId");
  return id?.trim() ? id : undefined;
}
