import type { NextConfig } from "next";

const config: NextConfig = {
  // Search and navigation URLs can contain private user input.
  logging: { incomingRequests: false },
};

export default config;
