import { describe, expect, test } from "bun:test";
import { validateRasterBytes, type RasterMimeType, type RasterRejectionCode,
  type RasterValidationLimits, type RasterValidationResult } from "../src/storage/media-validation";
import { corruptLaterWebp, corruptPngPixels, encodedJpeg, encodedWebp, independentApng, independentGif,
  independentPng, rasterLimits, redBlueRgba, truncatedJpegScan } from "./fixtures/media-rasters";

const accepted = (mimeType: RasterMimeType): RasterValidationResult => ({ok:true,mimeType});
const rejected = (code: RasterRejectionCode): RasterValidationResult => ({ok:false,code});
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("raster validation format core with controlled tiny bytes", () => {
  test("accepts a fully decoded independent PNG rather than merely its signature", async () => {
    await expect(validateRasterBytes(independentPng(),rasterLimits)).resolves.toEqual(accepted("image/png"));
  });

  test("independent PNG and GIF fixtures decode to the specified pixels, including every GIF frame", async () => {
    const {default:sharp} = await import("sharp");
    for (const [bytes,width,height,pages] of [
      [independentPng(),2,1,1], [independentPng(true),1,2,1], [independentGif(true),1,2,2],
    ] as const) {
      const decoded = await sharp(bytes,{animated:true,failOn:"warning"}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      expect(decoded.info.width).toBe(width); expect(decoded.info.height).toBe(height);
      expect(decoded.info.channels).toBe(4); expect(new Uint8Array(decoded.data)).toEqual(redBlueRgba);
      const metadata = await sharp(bytes,{animated:true}).metadata();
      expect(metadata.pages ?? 1).toBe(pages);
    }
  });

  test("accepts fully decoded small JPEG and lossless WebP with explicit independent dimensions", async () => {
    const {default:sharp} = await import("sharp");
    const jpeg = await encodedJpeg(), webp = await encodedWebp();
    const decoded = await sharp(jpeg,{failOn:"warning"}).raw().toBuffer({resolveWithObject:true});
    expect(decoded.info.width).toBe(2); expect(decoded.info.height).toBe(2); expect(decoded.info.channels).toBe(3);
    const lossless = await sharp(webp,{failOn:"warning"}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    expect(lossless.info.width).toBe(2); expect(lossless.info.height).toBe(1);
    expect(new Uint8Array(lossless.data)).toEqual(redBlueRgba);
    await expect(validateRasterBytes(jpeg,rasterLimits)).resolves.toEqual(accepted("image/jpeg"));
    await expect(validateRasterBytes(webp,rasterLimits)).resolves.toEqual(accepted("image/webp"));
    await expect(validateRasterBytes(independentGif(),rasterLimits)).resolves.toEqual(accepted("image/gif"));
  });

  test("does not accept intact PNG framing when the compressed pixels cannot decode", async () => {
    await expect(validateRasterBytes(corruptPngPixels(),rasterLimits)).resolves.toEqual(rejected("invalid-media"));
  });

  test("rejects a JPEG whose scan headers survive but compressed pixel data is truncated", async () => {
    await expect(validateRasterBytes(truncatedJpegScan(await encodedJpeg()),rasterLimits)).resolves.toEqual(rejected("invalid-media"));
  });

  for (const format of ["gif","webp"] as const) {
    test(`fully decodes both ${format} frames and applies dimensions per frame, not to the stacked output`, async () => {
      const bytes = format === "gif" ? independentGif(true) : await encodedWebp(true);
      const {default:sharp} = await import("sharp");
      const decoded = await sharp(bytes,{animated:true,failOn:"warning"}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      expect(decoded.info.width).toBe(1); expect(decoded.info.height).toBe(2);
      expect(new Uint8Array(decoded.data)).toEqual(redBlueRgba);
      expect((await sharp(bytes,{animated:true}).metadata()).pages).toBe(2);
      await expect(validateRasterBytes(bytes,{...rasterLimits,maxDimension:1,maxTotalPixels:2,maxFrames:2})).resolves.toEqual(accepted(`image/${format}`));
    });

    test(`rejects invalid later ${format} pixel data rather than accepting only the valid first frame`, async () => {
      const bytes = format === "gif" ? independentGif(true,true) : corruptLaterWebp(await encodedWebp(true));
      await expect(validateRasterBytes(bytes,rasterLimits)).resolves.toEqual(rejected("invalid-media"));
    });

    test(`counts all ${format} frames against frame and aggregate decoded-pixel budgets without truncation`, async () => {
      const bytes = format === "gif" ? independentGif(true) : await encodedWebp(true);
      await expect(validateRasterBytes(bytes,{...rasterLimits,maxFrames:1})).resolves.toEqual(rejected("resource-limit"));
      await expect(validateRasterBytes(bytes,{...rasterLimits,maxTotalPixels:1})).resolves.toEqual(rejected("resource-limit"));
    });

    test(`rejects a truncated ${format} without returning a partial first-frame success`, async () => {
      const bytes = format === "gif" ? independentGif(true) : await encodedWebp(true);
      await expect(validateRasterBytes(bytes.subarray(0,bytes.length-4),rasterLimits)).resolves.toEqual(rejected("invalid-media"));
    });
  }

  test("rejects APNG explicitly instead of silently validating only its default PNG frame", async () => {
    const bytes = independentApng(), {default:UPNG} = await import("@cantoo/pdf-lib/upng");
    const image = UPNG.decode(new Uint8Array(bytes).buffer);
    expect(image.width).toBe(2); expect(image.height).toBe(1); expect(image.tabs.acTL?.num_frames).toBe(2);
    expect(UPNG.toRGBA8(image).map(frame => new Uint8Array(frame))).toEqual([
      redBlueRgba,Uint8Array.of(0,255,0,255,255,255,255,255),
    ]);
    await expect(validateRasterBytes(bytes,rasterLimits)).resolves.toEqual(rejected("unsupported-animation"));
  });

  test("enforces actual byte length and inclusive test-owned dimension/pixel budgets", async () => {
    const bytes = independentPng();
    await expect(validateRasterBytes(bytes,{...rasterLimits,maxBytes:bytes.length,maxDimension:2,maxTotalPixels:2,maxFrames:1})).resolves.toEqual(accepted("image/png"));
    await expect(validateRasterBytes(bytes,{...rasterLimits,maxBytes:bytes.length-1})).resolves.toEqual(rejected("resource-limit"));
    await expect(validateRasterBytes(bytes,{...rasterLimits,maxTotalPixels:1})).resolves.toEqual(rejected("resource-limit"));
    for (const image of [bytes,independentPng(true)]) {
      await expect(validateRasterBytes(image,{...rasterLimits,maxDimension:1})).resolves.toEqual(rejected("resource-limit"));
    }
  });

  test("uses only the supplied byte view and never changes the retained original bytes", async () => {
    const bytes = independentPng(), wrapped = new Uint8Array(bytes.length+4);
    wrapped.set([0,255],0); wrapped.set(bytes,2); wrapped.set([254,0],bytes.length+2);
    const before = new Uint8Array(wrapped), view = wrapped.subarray(2,bytes.length+2);
    await expect(validateRasterBytes(view,{...rasterLimits,maxBytes:view.byteLength})).resolves.toEqual(accepted("image/png"));
    expect(wrapped).toEqual(before);
    await expect(validateRasterBytes(wrapped,rasterLimits)).resolves.toEqual(rejected("unsupported-format"));
    expect(wrapped).toEqual(before);
  });

  test("rejects empty and signature-spoofed bytes with a portable content-free rejection", async () => {
    await expect(validateRasterBytes(new Uint8Array(),rasterLimits)).resolves.toEqual(rejected("invalid-media"));
    const spoofed = [
      new Uint8Array([137,80,78,71,13,10,26,10,...text("<svg>private-sentinel</svg>")]),
      new Uint8Array([0xff,0xd8,0xff,...text("<html>private-sentinel</html>")]),
      text("GIF89a<svg>private-sentinel</svg>"),
      text("RIFF\u0000\u0000\u0000\u0000WEBP<html>private-sentinel</html>"),
    ];
    for (const bytes of spoofed) await expect(validateRasterBytes(bytes,rasterLimits)).resolves.toEqual(rejected("invalid-media"));
  });

  test("returns unsupported-format for vector, HTML, and archive input rather than handing it to a raster decoder", async () => {
    const unsupported = [
      text('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///not-a-media-input/private-sentinel"/></svg>'),
      text('<!DOCTYPE html><img src="https://not-a-media-provider.invalid/private-sentinel">'),
      Uint8Array.of(0x50,0x4b,3,4,0,0,0,0),
      text("%PDF-1.7\nprivate-sentinel"),
    ];
    for (const bytes of unsupported) await expect(validateRasterBytes(bytes,rasterLimits)).resolves.toEqual(rejected("unsupported-format"));
  });

  test("refuses invalid explicit budgets rather than silently substituting production defaults", async () => {
    const invalid: readonly Partial<RasterValidationLimits>[] = [
      {maxBytes:0},{maxDimension:-1},{maxTotalPixels:1.5},{maxFrames:0},{maxBytes:Number.NaN},{maxFrames:Number.POSITIVE_INFINITY},
    ];
    for (const limit of invalid) await expect(validateRasterBytes(independentPng(),{...rasterLimits,...limit})).resolves.toEqual(rejected("invalid-limits"));
  });
});
