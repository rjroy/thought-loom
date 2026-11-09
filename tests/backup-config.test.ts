import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig, validateConfig } from "../src/daemon/config";

const env = {
  THOUGHTLOOM_USER_TOKEN: "user-0123456789-0123456789-abcdef",
  THOUGHTLOOM_AI_TOKEN: "agent-0123456789-0123456789-abcdef",
  THOUGHTLOOM_DB_PATH: "/tmp/opencode/config-owned/knowledge.sqlite",
  THOUGHTLOOM_MEDIA_DIR: "/tmp/opencode/config-owned/media",
};
const backup = {
  repositoryUrl: "git@code.example.test:team/thoughtloom.git",
  checkout: "/tmp/opencode/config-owned/backup",
  branch: "archive/weekly-1",
  intervalSeconds: null as number | null,
};
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const configured = (input: unknown) => parseConfig({ ...env, THOUGHTLOOM_BACKUP_CONFIG: JSON.stringify(input) });

function expectSafeFailure(action: () => unknown, privateValues: readonly string[] = []): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ConfigError);
  if (!(failure instanceof ConfigError)) throw new Error("Expected backup configuration failure");
  expect(failure.message).toContain("THOUGHTLOOM_BACKUP_CONFIG");
  for (const value of [env.THOUGHTLOOM_USER_TOKEN, env.THOUGHTLOOM_AI_TOKEN, backup.repositoryUrl, backup.checkout, ...privateValues]) {
    expect(failure.message).not.toContain(value);
  }
}

test("absent backup configuration has no defaults or parser filesystem effects", async () => {
  const dir = await mkdtemp("/tmp/opencode/backup-config-");
  try {
    const before = await readdir(dir);
    const parsed = parseConfig({ ...env, THOUGHTLOOM_DB_PATH: join(dir, "db", "knowledge.sqlite"), THOUGHTLOOM_MEDIA_DIR: join(dir, "media") });
    expect(parsed).not.toHaveProperty("backup");
    expect(await readdir(dir)).toEqual(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("explicit manual and scheduled settings accept ordinary generic SSH and HTTPS destinations", () => {
  const cases = [
    backup,
    { ...backup, repositoryUrl: "ssh://git@git.example.test/team/archive.git", intervalSeconds: 37 },
    { ...backup, repositoryUrl: "https://code.example.test/team/archive.git", intervalSeconds: Number.MAX_SAFE_INTEGER },
  ];
  for (const value of cases) {
    expect(configured(value)).toMatchObject({ backup: value });
    expect(validateConfig({ port: 0, dbPath: env.THOUGHTLOOM_DB_PATH, mediaDir: env.THOUGHTLOOM_MEDIA_DIR,
      credentials: { user: env.THOUGHTLOOM_USER_TOKEN, ai: env.THOUGHTLOOM_AI_TOKEN }, backup: value })).toMatchObject({ backup: value });
  }
});

test("configured backup JSON is explicit, closed and safely diagnosed", () => {
  for (const raw of ["", "  ", "{private-config-sentinel", "null", "[]", '"private-config-sentinel"']) {
    expectSafeFailure(() => parseConfig({ ...env, THOUGHTLOOM_BACKUP_CONFIG: raw }), ["private-config-sentinel"]);
  }
  const missingFields = Object.keys(backup).map(field => Object.fromEntries(Object.entries(backup).filter(([key]) => key !== field)));
  for (const input of [...missingFields, { ...backup, extra: "private-config-sentinel" }, { ...backup, repositoryUrl: null },
    { ...backup, checkout: 4 }, { ...backup, branch: false }, { ...backup, intervalSeconds: "37" },
    { ...backup, intervalSeconds: 0 }, { ...backup, intervalSeconds: -1 }, { ...backup, intervalSeconds: 1.5 },
    { ...backup, intervalSeconds: Number.MAX_SAFE_INTEGER + 1 }]) {
    expectSafeFailure(() => configured(input), ["private-config-sentinel"]);
    expectSafeFailure(() => validateConfig({ port: 0, dbPath: env.THOUGHTLOOM_DB_PATH, mediaDir: env.THOUGHTLOOM_MEDIA_DIR,
      credentials: { user: env.THOUGHTLOOM_USER_TOKEN, ai: env.THOUGHTLOOM_AI_TOKEN }, backup: input }), ["private-config-sentinel"]);
  }
});

test("checkout must be absolute and separate from application, database and media paths", () => {
  const invalid = ["relative/backup", env.THOUGHTLOOM_DB_PATH, `${env.THOUGHTLOOM_DB_PATH}/nested`, "/tmp/opencode/config-owned",
    env.THOUGHTLOOM_MEDIA_DIR, `${env.THOUGHTLOOM_MEDIA_DIR}/nested`, appRoot, join(appRoot, "backup")];
  for (const checkout of invalid) expectSafeFailure(() => configured({ ...backup, checkout }), [checkout]);
});

test("remote URL and branch validation reject credential exposure, helper transports and unsafe refs", () => {
  const urls = [
    "https://private-user:private-token@code.example.test/team/archive.git",
    "https://private-token@code.example.test/team/archive.git",
    "https://code.example.test/team/archive.git?token=private-token",
    "https://code.example.test/team/archive.git#private-token",
    "ext::sh -c private-token", "file:///tmp/private-token.git",
  ];
  for (const repositoryUrl of urls) expectSafeFailure(() => configured({ ...backup, repositoryUrl }), [repositoryUrl, "private-token"]);
  for (const branch of ["", "HEAD", "--upload-pack=private-token", "refs/heads/a..b", "archive/part.lock", "archive bad", "archive\nprivate-token"]) {
    expectSafeFailure(() => configured({ ...backup, branch }), [branch, "private-token"].filter(Boolean));
  }
});
