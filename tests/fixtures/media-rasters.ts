import { deflateSync } from "node:zlib";
import type { RasterValidationLimits } from "../../src/storage/media-validation";

export const rasterLimits: RasterValidationLimits = Object.freeze({maxBytes:8192,maxDimension:8,maxTotalPixels:64,maxFrames:4});
export const redBlueRgba = Uint8Array.of(255,0,0,255,0,0,255,255);
const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size,part) => size+part.byteLength,0));
  let offset = 0;
  for (const part of parts) { result.set(part,offset); offset += part.byteLength; }
  return result;
}
function u32(...values: readonly number[]): Uint8Array {
  const result = new Uint8Array(values.length*4), view = new DataView(result.buffer);
  values.forEach((value,index) => view.setUint32(index*4,value));
  return result;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(name: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const body = concat(ascii(name),data);
  return concat(u32(data.byteLength),body,u32(crc32(body)));
}
const pngSignature = Uint8Array.of(137,80,78,71,13,10,26,10);
function pngHeader(width: number, height: number): Uint8Array {
  return concat(pngSignature,pngChunk("IHDR",concat(u32(width,height),Uint8Array.of(8,6,0,0,0))));
}
/** Independent PNG bytes, not a Sharp encoder/decoder round trip: two known RGBA pixels and filter zero. */
export function independentPng(vertical = false): Uint8Array {
  const rows = vertical ? Uint8Array.of(0,255,0,0,255,0,0,0,255,255) : concat(Uint8Array.of(0),redBlueRgba);
  return concat(pngHeader(vertical ? 1 : 2,vertical ? 2 : 1),pngChunk("IDAT",deflateSync(rows)),pngChunk("IEND"));
}
/** IHDR, chunk lengths, CRCs and IEND are intact; the IDAT zlib stream contains no decodable pixels. */
export function corruptPngPixels(): Uint8Array {
  return concat(pngHeader(2,1),pngChunk("IDAT",Uint8Array.of(0x78,0x9c)),pngChunk("IEND"));
}
/** Valid two-frame APNG fixture. Initial policy explicitly rejects APNG rather than validating frame zero only. */
export function independentApng(): Uint8Array {
  const frame = (sequence: number): Uint8Array => pngChunk("fcTL",concat(u32(sequence,2,1,0,0),Uint8Array.of(0,1,0,10,0,0)));
  const first = deflateSync(concat(Uint8Array.of(0),redBlueRgba));
  const second = deflateSync(Uint8Array.of(0,0,255,0,255,255,255,255,255));
  return concat(pngHeader(2,1),pngChunk("acTL",u32(2,0)),frame(0),pngChunk("IDAT",first),
    frame(1),pngChunk("fdAT",concat(u32(2),second)),pngChunk("IEND"));
}
function gifFrame(blue: boolean, invalidLzw = false): Uint8Array {
  // Three 3-bit LZW codes: CLEAR(4), palette index(0/1), END(5). Code 7 after CLEAR is invalid.
  const codes = invalidLzw ? 0x7c : blue ? 0x4c : 0x44;
  return Uint8Array.of(0x21,0xf9,4,0,1,0,0,0,0x2c,0,0,0,0,1,0,1,0,0,2,2,codes,1,0);
}
/** Independent GIF89a with a red/blue global palette and one pixel per frame. */
export function independentGif(animated = false, corruptLater = false): Uint8Array {
  return concat(ascii("GIF89a"),Uint8Array.of(1,0,1,0,0x80,0,0,255,0,0,0,0,255),gifFrame(false),
    animated ? gifFrame(true,corruptLater) : new Uint8Array(),Uint8Array.of(0x3b));
}
export async function encodedJpeg(): Promise<Uint8Array> {
  const {default:sharp} = await import("sharp");
  const rgb = Uint8Array.of(255,0,0,0,255,0,0,0,255,255,255,255);
  return new Uint8Array(await sharp(rgb,{raw:{width:2,height:2,channels:3}}).jpeg({quality:90,chromaSubsampling:"4:4:4"}).toBuffer());
}
export async function encodedWebp(animated = false): Promise<Uint8Array> {
  const {default:sharp} = await import("sharp");
  const raw = animated ? {width:1,height:2,channels:4 as const,pageHeight:1} : {width:2,height:1,channels:4 as const};
  const encoder = sharp(redBlueRgba,{raw});
  return new Uint8Array(await encoder.webp(animated ? {lossless:true,effort:0,loop:0,delay:[20,20]} : {lossless:true,effort:0}).toBuffer());
}
/** Keep JPEG framing and scan headers, but cut almost all compressed pixel data. */
export function truncatedJpegScan(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for (let offset = 2; offset+4 < bytes.length; offset++) {
    if (bytes[offset] === 0xff && bytes[offset+1] === 0xda) {
      const start = offset+2+view.getUint16(offset+2);
      if (start+1 >= bytes.length-2) throw new Error("JPEG fixture has no complete pixel scan");
      return bytes.slice(0,start+1);
    }
  }
  throw new Error("JPEG fixture is missing a start-of-scan marker");
}
/** Controlled fixture mutation only: retain RIFF/ANMF lengths and damage the second lossless frame signature. */
export function corruptLaterWebp(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes), view = new DataView(result.buffer);
  const label = (offset: number): string => new TextDecoder().decode(result.subarray(offset,offset+4));
  let frames = 0;
  for (let offset = 12; offset+8 <= result.length;) {
    const size = view.getUint32(offset+4,true), end = offset+8+size;
    if (end > result.length) throw new Error("Incomplete controlled WebP fixture");
    if (label(offset) === "ANMF" && ++frames === 2) {
      for (let inner = offset+24; inner+8 <= end;) {
        const innerSize = view.getUint32(inner+4,true), innerEnd = inner+8+innerSize;
        if (innerEnd > end) throw new Error("Incomplete controlled WebP frame");
        if (label(inner) === "VP8L" && innerSize >= 5 && result[inner+8] === 0x2f) { result[inner+8] = 0; return result; }
        inner = innerEnd+(innerSize & 1);
      }
      throw new Error("Second controlled WebP frame has no lossless payload");
    }
    offset = end+(size & 1);
  }
  throw new Error("Controlled WebP fixture has fewer than two frames");
}
