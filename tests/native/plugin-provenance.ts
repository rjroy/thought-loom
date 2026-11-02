// Indexed-search candidate, pending review. These exact bytes are review inputs,
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
  "packages/agent-tools/src/plugin.ts": "79b385d21ba4be3c2606a61b45597c346e3d207b4b0282b7d6f9799b062fb7c9",
  "packages/agent-tools/src/capabilities.ts": "6520489ed401277ffb956e79baf1d27aa9829fab4230345304a1511b2a3a6923",
  "packages/contracts/src/tools.ts": "68e150b1ed3ed1c92c736e03d445b89161ce399f5529a352ec0090a73da2c006",
  "packages/contracts/src/native-capabilities.ts": "e0362fe75b65332a8b30b85a75a678f819d4cbd544efa388c601ad9096e02d91",
  "packages/contracts/src/inspection.ts": "54f0d7d25cb176614fd025cd6dd6da524ca88aa56289f54ea54dc72fec55da17",
  "packages/contracts/src/search.ts": "f5cb53155dd6e7f3dcada9a7ffc68126ca6dc9817f3f97d9190aba5f681c58a2",
} as const;
export const BUNDLE_SHA256 = "d3a2042f7452926d7f41e3ccd772267969748eb7f4f5ced303fb4b52eaf93c4b";
