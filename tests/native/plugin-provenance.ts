// Fuzzy-retrieval candidate, pending review. These exact bytes are review inputs,
// NOT a claim that this bundle has executed. The earlier capture witness is
// historical evidence for its earlier bundle only (see README).
export const PLUGIN_PROVENANCE = {
  status: "authored-pending-review-and-execution",
  runtime: "bun@1.4.3",
  entrypoint: "packages/agent-tools/src/plugin.ts",
  build: { target: "bun", format: "esm", packages: "bundle" },
  registeredTools: 11,
} as const;
export const SOURCE_HASHES = {
  "packages/agent-tools/src/plugin.ts": "e24a9a0ea9c359474cd7d4c5cf7d505259a01e5cfbdafa6dcd8a130e13612955",
  "packages/agent-tools/src/capabilities.ts": "6520489ed401277ffb956e79baf1d27aa9829fab4230345304a1511b2a3a6923",
  "packages/contracts/src/tools.ts": "68e150b1ed3ed1c92c736e03d445b89161ce399f5529a352ec0090a73da2c006",
  "packages/contracts/src/native-capabilities.ts": "29606cba790fe816246265ba0c9cd0d98aa2966295df29541d6d17a98763b3cc",
  "packages/contracts/src/inspection.ts": "54f0d7d25cb176614fd025cd6dd6da524ca88aa56289f54ea54dc72fec55da17",
  "packages/contracts/src/search.ts": "fdcd134182be197665c027f57cdbd25d0b45e7c99877754b058c9ab1dcef4ea7",
} as const;
export const BUNDLE_SHA256 = "ff8ff61b62a2fb412bc8e55aaabc7f28405d62fa3e2101d368f00a3110b5a6de";
