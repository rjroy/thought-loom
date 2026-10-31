import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep the local user-testable surface clear, especially on a phone viewport.
  // Compile/runtime errors are still reported by Next.
  devIndicators: false,
  // Search terms are personal content. Boundary logs below omit their text;
  // don't duplicate raw query-bearing request URLs in the development terminal.
  logging: { incomingRequests: false },
};

export default config;
