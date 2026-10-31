import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep the local user-testable surface clear, especially on a phone viewport.
  // Compile/runtime errors are still reported by Next.
  devIndicators: false,
};

export default config;
