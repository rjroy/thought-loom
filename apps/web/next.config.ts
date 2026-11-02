import type { NextConfig } from "next";
import { resolve } from "node:path";

// Next evaluates its transpiled config through a synthetic CommonJS module;
// resolve explicitly so its require hook can load the shared TypeScript source.
const { allowedHostname }: typeof import("../../packages/contracts/src/local-request") = require(resolve(__dirname, "../../packages/contracts/src/local-request.ts"));

const allowedHost = allowedHostname(process.env.THOUGHTLOOM_ALLOWED_HOST);

const config: NextConfig = {
  allowedDevOrigins: allowedHost ? [allowedHost] : [],
  // Keep the local user-testable surface clear, especially on a phone viewport.
  // Compile/runtime errors are still reported by Next.
  devIndicators: false,
  // Search terms are personal content. Boundary logs below omit their text;
  // don't duplicate raw query-bearing request URLs in the development terminal.
  logging: { incomingRequests: false },
};

export default config;
