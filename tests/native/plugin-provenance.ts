// Deliberate phase-4 refresh, 2026-10-31. These exact bytes are review inputs,
// NOT a claim that this bundle has executed. The earlier capture witness is
// historical evidence for its earlier bundle only (see README).
export const PLUGIN_PROVENANCE = {
  status: "authored-pending-review-and-execution",
  runtime: "bun@1.4.3",
  entrypoint: "packages/agent-tools/src/plugin.ts",
  build: { target: "bun", format: "esm", packages: "bundle" },
  registeredTools: 10,
} as const;
export const SOURCE_HASHES = {
  "packages/agent-tools/src/plugin.ts": "4e5f62a7806cf9a1a49f3edaa1a9f2b6c846d641ef910d0b9e699d2dffc04153",
  "packages/contracts/src/tools.ts": "ad18dc44175e900d98d07a89f44481141aab08c946d3a95999c45ff2cf638fef",
} as const;
export const BUNDLE_SHA256 = "eb68510bdc3d1989683a8b6c5ae3caab47c6785a626c3c63f6a79517ab71f04c";
