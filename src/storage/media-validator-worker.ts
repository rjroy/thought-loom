// This entry is launched only behind the supervisor's process resource limits.
import { validateRasterBytes, type RasterValidationLimits } from "./media-validation";
import { validatePdfBytes, type PdfValidationLimits } from "./media-pdf-validation";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function configuration(raw: string | undefined): {raster: RasterValidationLimits; pdf: PdfValidationLimits} | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || !object(parsed.raster) || !object(parsed.pdf)) return undefined;
    const r = parsed.raster, p = parsed.pdf;
    if (!number(r.maxBytes) || !number(r.maxDimension) || !number(r.maxTotalPixels) || !number(r.maxFrames) ||
        !number(p.maxBytes) || !number(p.maxPages) || !number(p.maxObjects) || !number(p.maxDepth)) return undefined;
    return {raster:{maxBytes:r.maxBytes,maxDimension:r.maxDimension,maxTotalPixels:r.maxTotalPixels,maxFrames:r.maxFrames},
      pdf:{maxBytes:p.maxBytes,maxPages:p.maxPages,maxObjects:p.maxObjects,maxDepth:p.maxDepth}};
  } catch { return undefined; }
}

async function main(): Promise<void> {
  const config = configuration(process.argv[2]);
  if (!config) { process.stdout.write('{"ok":false,"code":"invalid-limits"}'); return; }
  const maxBytes = Math.max(config.raster.maxBytes,config.pdf.maxBytes);
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of Bun.stdin.stream()) {
    if (chunk.byteLength > maxBytes-length) {
      process.stdout.write('{"ok":false,"code":"resource-limit"}');
      return;
    }
    length += chunk.byteLength;
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts,length);
  const isPdf = bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d;
  const result = isPdf ? await validatePdfBytes(bytes,config.pdf) : await validateRasterBytes(bytes,config.raster);
  process.stdout.write(JSON.stringify(result));
}

try { await main(); } catch { process.stdout.write('{"ok":false,"code":"invalid-media"}'); }
