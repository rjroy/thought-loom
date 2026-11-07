import sharp from "sharp";

export type RasterMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface RasterValidationLimits {
  readonly maxBytes: number;
  /** Per-frame width and height, not the decoder's vertically stacked animation height. */
  readonly maxDimension: number;
  readonly maxTotalPixels: number;
  readonly maxFrames: number;
}
export type RasterRejectionCode = "invalid-limits" | "unsupported-format" | "unsupported-animation" | "invalid-media" | "resource-limit";
export type RasterValidationResult = { readonly ok: true; readonly mimeType: RasterMimeType } |
  { readonly ok: false; readonly code: RasterRejectionCode };

type RasterFormat = "png" | "jpeg" | "gif" | "webp";

const mimeTypes: Record<RasterFormat, RasterMimeType> = {
  png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** Only these headers may reach Sharp; in particular, never invoke its SVG renderer. */
function rasterFormat(bytes: Uint8Array): RasterFormat | undefined {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [71, 73, 70, 56, 55, 97]) || startsWith(bytes, [71, 73, 70, 56, 57, 97])) return "gif";
  if (startsWith(bytes, [82, 73, 70, 70]) && startsWith(bytes, [87, 69, 66, 80], 8)) return "webp";
  return undefined;
}

/** Inspect chunk boundaries only to prevent a default-frame-only APNG acceptance. */
function pngAnimation(bytes: Uint8Array): "animated" | "static" | "invalid" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset < bytes.byteLength;) {
    if (bytes.byteLength - offset < 12) return "invalid";
    const length = view.getUint32(offset);
    if (length > bytes.byteLength - offset - 12) return "invalid";
    if (startsWith(bytes, [97, 99, 84, 76], offset + 4) ||
        startsWith(bytes, [102, 99, 84, 76], offset + 4) ||
        startsWith(bytes, [102, 100, 65, 84], offset + 4)) return "animated";
    offset += length + 12;
  }
  return "static";
}

/** Check GIF container completeness; Sharp still decodes every frame's pixel data. */
function gifFrameCount(bytes: Uint8Array): number | undefined {
  // Header and logical screen descriptor, followed by an optional global colour table.
  if (bytes.byteLength < 13) return undefined;
  let offset = 13;
  const globalPacked = bytes[10];
  if (globalPacked & 0x80) offset += 3 * (1 << ((globalPacked & 7) + 1));
  if (offset > bytes.byteLength) return undefined;

  const skipSubBlocks = (): boolean => {
    while (offset < bytes.byteLength) {
      const size = bytes[offset++];
      if (size === 0) return true;
      if (size > bytes.byteLength - offset) return false;
      offset += size;
    }
    return false;
  };

  let frames = 0;
  while (offset < bytes.byteLength) {
    const introducer = bytes[offset++];
    if (introducer === 0x3b) return frames > 0 && offset === bytes.byteLength ? frames : undefined;
    if (introducer === 0x21) {
      if (offset >= bytes.byteLength) return undefined;
      offset++; // Extension label; its payload consists of length-prefixed sub-blocks.
      if (!skipSubBlocks()) return undefined;
    } else if (introducer === 0x2c) {
      if (bytes.byteLength - offset < 9) return undefined;
      const packed = bytes[offset + 8];
      offset += 9;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
      if (offset >= bytes.byteLength) return undefined;
      offset++; // LZW minimum code size, followed by compressed data sub-blocks.
      if (!skipSubBlocks()) return undefined;
      frames++;
    } else {
      return undefined;
    }
  }
  return undefined; // A sub-block terminator is not the GIF trailer.
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Format-core entry point for the future bounded validator worker, never daemon-side decoding. */
export async function validateRasterBytes(bytes: Uint8Array, limits: RasterValidationLimits): Promise<RasterValidationResult> {
  const reject = (code: RasterRejectionCode): RasterValidationResult => ({ ok: false, code });
  if (![limits.maxBytes, limits.maxDimension, limits.maxTotalPixels, limits.maxFrames].every(positiveSafeInteger)) {
    return reject("invalid-limits");
  }
  if (bytes.byteLength > limits.maxBytes) return reject("resource-limit");
  if (bytes.byteLength === 0) return reject("invalid-media");
  const format = rasterFormat(bytes);
  if (!format) return reject("unsupported-format");
  if (format === "png") {
    const animation = pngAnimation(bytes);
    if (animation === "animated") return reject("unsupported-animation");
    if (animation === "invalid") return reject("invalid-media");
  }
  const gifFrames = format === "gif" ? gifFrameCount(bytes) : undefined;
  if (format === "gif" && gifFrames === undefined) return reject("invalid-media");
  if (gifFrames !== undefined && gifFrames > limits.maxFrames) return reject("resource-limit");

  try {
    // Copy exactly the supplied view, so native decoding cannot alter retained input.
    const input = Buffer.from(bytes);
    const options = { animated: true, failOn: "warning" as const, limitInputPixels: false as const };
    const metadata = await sharp(input, options).metadata();
    if (metadata.format !== format) return reject("invalid-media");
    const { width, height } = metadata;
    const frames = metadata.pages ?? 1;
    if (gifFrames !== undefined && frames !== gifFrames) return reject("invalid-media");
    const frameHeight = metadata.pageHeight ?? (frames === 1 ? height : 0);
    if (![width, height, frames, frameHeight].every(positiveSafeInteger) ||
        frameHeight * frames !== height || !Number.isSafeInteger(frameHeight * frames)) {
      return reject("invalid-media");
    }
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || width > limits.maxDimension || frameHeight > limits.maxDimension ||
        frames > limits.maxFrames || pixels > limits.maxTotalPixels || !Number.isSafeInteger(pixels * 4)) {
      return reject("resource-limit");
    }

    // Materialize every frame, not just metadata or the default frame. Fixed RGBA
    // output lets us verify the decoded dimensions and complete byte count.
    const { data, info } = await sharp(input, options).toColourspace("srgb").ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 4 ||
        data.byteLength !== pixels * 4 || info.size !== data.byteLength) return reject("invalid-media");
    return { ok: true, mimeType: mimeTypes[format] };
  } catch {
    return reject("invalid-media");
  }
}
