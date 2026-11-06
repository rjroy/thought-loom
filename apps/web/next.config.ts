import type { NextConfig } from "next";
import { readWebConfig } from "./src/server/config";

const webHostname = new URL(readWebConfig({ THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN }).webOrigin).hostname;
// Next interprets asterisks as hostname patterns, not literal hostnames.
if (webHostname.includes("*")) throw new Error("Invalid local origin");

const rawImportMaxBytes = process.env.THOUGHTLOOM_IMPORT_MAX_BYTES;
const importMaxBytes = rawImportMaxBytes === undefined ? 1048576 : Number(rawImportMaxBytes);
// The daemon allows up to 4096 metadata bytes in addition to multipart framing.
const multipartAllowance = 4096 + 65536;
if ((rawImportMaxBytes !== undefined && !/^\d+$/.test(rawImportMaxBytes))
    || !Number.isSafeInteger(importMaxBytes) || importMaxBytes < 1
    || importMaxBytes > Number.MAX_SAFE_INTEGER - multipartAllowance) {
  throw new Error("THOUGHTLOOM_IMPORT_MAX_BYTES must be a positive safe integer with room for multipart overhead");
}

const config: NextConfig = {
  allowedDevOrigins: [webHostname],
  // Search and navigation URLs can contain private user input.
  logging: { incomingRequests: false },
  experimental: {
    // Preserve Next's default for other routes while allowing configured uploads.
    proxyClientMaxBodySize: Math.max(10 * 1024 * 1024, importMaxBytes + multipartAllowance),
  },
};

export default config;
