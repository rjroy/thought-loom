// This authority guard is not authentication or a network firewall.
// Parse the wire authority strictly before URL normalization can hide userinfo,
// alternate IP spellings, lists, whitespace, or invalid/ambiguous ports.
export function allowedHostname(value: string | undefined): string | null {
  if (!value || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) return null;
  const hostname = value.toLowerCase();
  try { return new URL(`http://${hostname}`).hostname === hostname ? hostname : null; } catch { return null; }
}

function authority(value: string): string | null {
  const match = /^(\[::1\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match) return null;
  const hostname = match[1].toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname) && hostname !== allowedHostname(process.env.THOUGHTLOOM_ALLOWED_HOST)) return null;
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null;
  try { return new URL(`http://${value}`).host.toLowerCase(); } catch { return null; }
}

function originMatches(origin: string | null, host: string | null): boolean {
  if (origin === null) return true;
  const match = /^http:\/\/([^/?#]+)$/i.exec(origin);
  return !!host && !!match && authority(match[1]) === host;
}

export function isAllowedRequestOrigin(request: Request): boolean {
  return originMatches(request.headers.get("origin"), authority(request.headers.get("host") ?? ""));
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
  return originMatches(request.headers.get("origin"), host);
}
