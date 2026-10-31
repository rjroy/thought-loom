import type { URLPatternInput as NodeURLPatternInput, URLPatternOptions as NodeURLPatternOptions } from "node:url";

// Next 16.4.3's declarations reference these global names. TS 5.9's DOM lib
// does not expose them; use the exact Node 26 definitions instead of disabling
// declaration checking or inventing permissive placeholder types.
declare global {
  type URLPatternInput = NodeURLPatternInput;
  type URLPatternOptions = NodeURLPatternOptions;
}
