import type { NextConfig } from "next";
import { readWebConfig } from "./src/server/config";

const webOrigins = readWebConfig({
  THOUGHTLOOM_WEB_ORIGIN: process.env.THOUGHTLOOM_WEB_ORIGIN,
  THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS: process.env.THOUGHTLOOM_WEB_ADDITIONAL_ORIGINS,
}).webOrigins;
const webHostnames = [...new Set(webOrigins.map(value => new URL(value).hostname))];

// The daemon allows up to 4096 metadata bytes in addition to multipart framing.
const multipartAllowance = 4096 + 65536;
function uploadLimit(name: "THOUGHTLOOM_IMPORT_MAX_BYTES" | "THOUGHTLOOM_MEDIA_MAX_BYTES", fallback: number): number {
  const raw = process.env[name], value = raw === undefined ? fallback : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < 1
      || value > Number.MAX_SAFE_INTEGER - multipartAllowance) {
    throw new Error(`${name} must be a positive safe integer with room for multipart overhead`);
  }
  return value;
}
const importMaxBytes = uploadLimit("THOUGHTLOOM_IMPORT_MAX_BYTES",1048576);
const mediaMaxBytes = uploadLimit("THOUGHTLOOM_MEDIA_MAX_BYTES",16777216);

const config: NextConfig = {
  allowedDevOrigins: webHostnames,
  // Search and navigation URLs can contain private user input.
  logging: { incomingRequests: false },
  experimental: {
    // Preserve Next's default for other routes while allowing configured uploads.
    proxyClientMaxBodySize: Math.max(10 * 1024 * 1024, importMaxBytes + multipartAllowance, mediaMaxBytes + multipartAllowance),
  },
};

export default config;
