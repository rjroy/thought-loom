import { uniqueKeys } from "../domain/run-protocol";

export class ImportHttpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 415 | 422 | 503, readonly code: string) { super(code); }
}
export const invalidImport = (): never => { throw new ImportHttpError(400,"invalid-import-request"); };
export const metadataLimit = 4096;
export const multipartOverhead = 65536;

export function strictObject(text: string, allowed: readonly string[], bad = invalidImport): Record<string,unknown> {
  try {
    const value: unknown = JSON.parse(text);
    uniqueKeys(text);
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(name => !allowed.includes(name))) return bad();
    return Object.fromEntries(Object.entries(value));
  } catch { return bad(); }
}
export async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0, complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) { complete = true; break; }
      length += item.value.byteLength;
      if (length > limit) throw new ImportHttpError(413,"source-too-large");
      chunks.push(item.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.length; }
    return result;
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* Request is already gone. */ } }
    reader.releaseLock();
  }
}
export function utf8(bytes: Uint8Array, bad = invalidImport): string {
  try { return new TextDecoder("utf-8",{fatal:true}).decode(bytes); } catch { return bad(); }
}
export function multipartBoundary(contentType: string): string {
  const media = /^multipart\/form-data\s*;\s*boundary=(?:([A-Za-z0-9'()+_,.\/:=?-]{1,70})|"([A-Za-z0-9'()+_,.\/:=?-]{1,70})")\s*$/i.exec(contentType);
  const boundary = media?.[1] ?? media?.[2];
  if (!boundary) throw new ImportHttpError(415,"unsupported-media-type");
  return boundary;
}
/** One metadata part and one file, with bounded headers and fatal UTF-8 decoding. */
export function multipart(bytes: Uint8Array, boundary: string, bad = invalidImport): {
  metadata: string; metadataBytes: number; file: Uint8Array; filename: string | undefined; mimeType: string | undefined;
} {
  const data = Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const marker = Buffer.from(`--${boundary}`), delimiter = Buffer.from(`\r\n--${boundary}`);
  if (!data.subarray(0,marker.length).equals(marker)) return bad();
  let position = marker.length, metadata: string | undefined, metadataBytes = 0, file: Uint8Array | undefined;
  let filename: string | undefined, mimeType: string | undefined;
  while (true) {
    if (data.subarray(position,position+2).equals(Buffer.from("--"))) {
      position += 2;
      if (position !== data.length && !(position+2 === data.length && data.subarray(position).equals(Buffer.from("\r\n")))) return bad();
      break;
    }
    if (!data.subarray(position,position+2).equals(Buffer.from("\r\n"))) return bad();
    position += 2;
    const endHeaders = data.indexOf("\r\n\r\n",position);
    if (endHeaders < 0 || endHeaders-position > multipartOverhead) return bad();
    const headerBytes = data.subarray(position,endHeaders);
    if (headerBytes.some(byte => byte < 32 && byte !== 13 && byte !== 10 && byte !== 9)) return bad();
    const headers = new Map<string,string>();
    for (const line of utf8(headerBytes,bad).split("\r\n")) {
      const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
      if (!match || !match[1] || match[2] === undefined) return bad();
      const name = match[1].toLowerCase();
      if (headers.has(name) || (name !== "content-disposition" && name !== "content-type")) return bad();
      headers.set(name,match[2]);
    }
    const disposition = headers.get("content-disposition") ?? "";
    const part = /^form-data;\s*name="(metadata|file)"(?:;\s*filename="((?:[^"\\\r\n]|\\["\\])*)")?\s*$/i.exec(disposition);
    if (!part) return bad();
    const start = endHeaders+4;
    let end = data.indexOf(delimiter,start);
    while (end >= 0) {
      const suffix = data.subarray(end+delimiter.length,end+delimiter.length+2);
      if (suffix.equals(Buffer.from("\r\n")) || suffix.equals(Buffer.from("--"))) break;
      end = data.indexOf(delimiter,end+delimiter.length);
    }
    if (end < 0) return bad();
    if (part[1] === "metadata") {
      if (metadata !== undefined || part[2] !== undefined || end-start > metadataLimit) return bad();
      metadata = utf8(data.subarray(start,end),bad);
      metadataBytes = end-start;
    } else if (part[1] === "file") {
      if (file !== undefined) return bad();
      file = data.subarray(start,end);
      filename = part[2]?.replace(/\\(["\\])/g,"$1");
      mimeType = headers.get("content-type")?.trim().toLowerCase();
    } else return bad();
    position = end+2+marker.length;
  }
  if (metadata === undefined || file === undefined) return bad();
  return {metadata,metadataBytes,file,filename,mimeType};
}
