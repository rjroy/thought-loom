// Test-only re-export through the workspace that declares these exact pinned
// dependencies. No service discovery or startup happens on import.
export { OpenCode } from "@opencode/client";
export type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
export { Service } from "@opencode/client/service";
