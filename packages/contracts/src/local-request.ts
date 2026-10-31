// This is a loopback exposure guard, not authentication against local processes.
// Parse the wire authority strictly before URL normalization can hide userinfo,
// alternate IP spellings, lists, whitespace, or invalid/ambiguous ports.
function authority(value: string): string | null {
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match) return null;
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null;
  try { return new URL(`http://${value}`).host.toLowerCase(); } catch { return null; }
}

export function isLocalRequest(request: Request): boolean {
  let url: URL;
  try { url = new URL(request.url); } catch { return false; }
  if (url.protocol !== "http:" || url.username || url.password || !authority(url.host)) return false;
  const rawHost = request.headers.get("host");
  const host = authority(rawHost ?? url.host);
  if (!host) return false;
  // Forwarded fields cannot establish authority. Reject public or ambiguous
  // hints, while allowing Next's ordinary loopback x-forwarded-* defaults.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if ((forwardedHost !== null && !authority(forwardedHost)) ||
      (forwardedProto !== null && forwardedProto.toLowerCase() !== "http") || request.headers.has("forwarded")) return false;
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const match = /^http:\/\/([^/?#]+)$/i.exec(origin);
  return !!match && authority(match[1]) === host;
}
