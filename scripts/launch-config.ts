import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

const allowed = new Set(["THOUGHTLOOM_DATABASE_PATH", "THOUGHTLOOM_WEB_PORT", "THOUGHTLOOM_DAEMON_PORT", "THOUGHTLOOM_NATIVE_CONFIG_FILE", "THOUGHTLOOM_TOOL_CONNECTION_FILE"]);
type LaunchConfig = { values: Record<string, string>; databasePath: string; webPort: number; daemonPort: number };

export async function readLaunchConfig(path: string): Promise<LaunchConfig> {
  if (!isAbsolute(path)) throw new Error("Launch file path must be absolute");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600 || info.size > 65536) throw new Error("Launch file must be an owned, non-symlink regular file with mode 0600");
    text = await file.readFile({ encoding: "utf8" });
  } finally { await file.close(); }
  const values: Record<string, string> = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(values, match[1])) throw new Error("Invalid or duplicate launch setting");
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error("Invalid quoted launch value"); }
      if (typeof value !== "string") throw new Error("Invalid launch value");
    } else if (!value || /[\s'"\\#]/.test(value)) throw new Error("Invalid unquoted launch value");
    if (!value || /[\0\r\n]/.test(value)) throw new Error("Invalid launch value");
    values[match[1]] = value;
  }
  for (const key of ["THOUGHTLOOM_DATABASE_PATH", "THOUGHTLOOM_NATIVE_CONFIG_FILE", "THOUGHTLOOM_TOOL_CONNECTION_FILE"]) {
    const value = values[key];
    if (key === "THOUGHTLOOM_DATABASE_PATH" && !value) throw new Error(`${key} is required`);
    if (value && (!isAbsolute(value) || !(await stat(value)).isFile())) throw new Error(`${key} must name an existing absolute file`);
  }
  function port(key: string): number {
    const value = values[key];
    if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`${key} must be an explicit port between 1024 and 65535`);
    return Number(value);
  }
  const webPort = port("THOUGHTLOOM_WEB_PORT"), daemonPort = port("THOUGHTLOOM_DAEMON_PORT");
  if (webPort === daemonPort) throw new Error("Web and daemon ports must differ");
  return { values, databasePath: values.THOUGHTLOOM_DATABASE_PATH, webPort, daemonPort };
}
