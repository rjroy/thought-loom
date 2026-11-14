// Private, fixed entry point. The parent owns deadlines, RSS monitoring and joined cancellation.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { uniqueKeys } from "../domain/run-protocol";
import { mediaFileId } from "../storage/media-file-paths";
import { encodeManifest, encodeTable, type BackupManifest } from "./format";
import { BackupSchemaError } from "./schema";
import { readSource, table, text, bytes, integer, validateBytes, type SqlSnapshot } from "./capture-source";
import { absent, BackupCaptureError, canonical, check, childDirectory, empty, fingerprint, newFile, openDirectory, smallFile, sourceGuard,
  unchanged, verifyDirectory, verifyFile, workerFailureCodes, writeFile, type Directory, type Guard } from "./capture-files";

interface Request {
  readonly version: 1;
  readonly databasePath: string;
  readonly mediaDirectory: string;
  readonly databaseDev: string;
  readonly databaseIno: string;
}
const utf8 = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
async function notify(value: object): Promise<void> { await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function request(raw: Uint8Array): Request {
  const encoded = decoder.decode(raw), value: unknown = JSON.parse(encoded);
  check(record(value) && JSON.stringify(value) === encoded && Object.keys(value).length === 5 && value.version === 1 &&
    typeof value.databasePath === "string" && typeof value.mediaDirectory === "string" &&
    typeof value.databaseDev === "string" && /^[0-9]+$/.test(value.databaseDev) &&
    typeof value.databaseIno === "string" && /^[0-9]+$/.test(value.databaseIno), "invalid-control-file");
  return { version: 1, databasePath: value.databasePath, mediaDirectory: value.mediaDirectory, databaseDev: value.databaseDev, databaseIno: value.databaseIno };
}
async function awaitReadAuthorization(): Promise<void> {
  // A bounded one-shot handshake lets the supervisor establish monitoring and log the actual pinned snapshot before reading rows.
  const bytes = Buffer.alloc(16); let length = 0;
  for await (const chunk of Bun.stdin.stream()) {
    check(chunk.length < bytes.length - length, "invalid-control-input");
    bytes.set(chunk, length); length += chunk.length;
  }
  check(bytes.subarray(0, length).equals(Buffer.from("read\n")), "invalid-control-input");
}
async function media(snapshot: SqlSnapshot, directory: string, stage: Directory, guard: Guard): Promise<Pick<BackupManifest, "mediaStoreId" | "mediaMarker" | "originals">> {
  const stores = table(snapshot, "media_store").rows, sources = table(snapshot, "media_sources").rows;
  check(stores.length <= 1);
  if (stores.length === 0) {
    check(sources.length === 0);
    let unused: Directory;
    try { unused = await openDirectory(directory); } catch (error) { if (absent(error)) return { mediaStoreId: null, mediaMarker: null, originals: [] }; throw error; }
    try { check(await empty(unused), "store-identity-conflict"); } finally { await unused.handle.close(); }
    return { mediaStoreId: null, mediaMarker: null, originals: [] };
  }
  const storeId = mediaFileId(text(stores[0], "store_id")), root = await openDirectory(directory);
  let objects: Directory | undefined, target: Directory | undefined, originalsDirectory: Directory | undefined;
  try {
    guard(); const before = lstatSync(`${root.anchor}/store.json`, { bigint: true });
    const markerBytes = await smallFile(root, "store.json", 1024), markerText = decoder.decode(markerBytes), marker: unknown = JSON.parse(markerText);
    uniqueKeys(markerText);
    check(record(marker) && Object.keys(marker).length === 2 && marker.version === 1 && marker.storeId === storeId, "store-identity-conflict");
    objects = await childDirectory(root, "objects"); target = await childDirectory(stage, "media", true);
    if (sources.length > 0) originalsDirectory = await childDirectory(target, "objects", true);
    const originalDirectory = objects;
    const fileGuard = () => { guard(); verifyDirectory(root); verifyDirectory(originalDirectory); };
    const originals: BackupManifest["originals"][number][] = [];
    for (const source of sources) {
      const output = originalsDirectory; check(output !== undefined);
      fileGuard(); const sourceId = mediaFileId(text(source, "id")), length = integer(source, "byte_length"), digest = bytes(source, "sha256");
      check(length > 0n && length <= BigInt(Number.MAX_SAFE_INTEGER) && digest.length === 32);
      const expected = Buffer.from(digest).toString("hex"), destination = await newFile(output, sourceId);
      try {
        const copied = await fingerprint(originalDirectory, sourceId, fileGuard, destination);
        check(copied.byteLength === length.toString() && copied.sha256 === expected, "original-unavailable");
        verifyFile(output, sourceId, destination, false);
      } finally { await destination.handle.close(); }
      const saved = await fingerprint(output, sourceId, fileGuard);
      check(saved.byteLength === length.toString() && saved.sha256 === expected, "original-unavailable");
      originals.push({ sourceId, path: `media/objects/${sourceId}`, byteLength: length.toString(), sha256: expected });
    }
    fileGuard(); check(unchanged(before, lstatSync(`${root.anchor}/store.json`, { bigint: true })), "store-identity-conflict");
    const canonicalMarker = utf8.encode(`${JSON.stringify({ version: 1, storeId })}\n`);
    await writeFile(target, "store.json", canonicalMarker, fileGuard);
    if (originalsDirectory) await originalsDirectory.handle.sync();
    await target.handle.sync();
    return { mediaStoreId: storeId, mediaMarker: { path: "media/store.json", byteLength: String(canonicalMarker.length), sha256: hash(canonicalMarker) }, originals };
  } finally {
    await Promise.allSettled([objects?.handle.close(), originalsDirectory?.handle.close(), target?.handle.close(), root.handle.close()]);
  }
}
async function main(): Promise<void> {
  check(process.argv.length === 3 && basename(process.argv[2]) === "request.json" && /^\.capture-[0-9a-f-]{36}$/.test(basename(dirname(process.argv[2]))), "invalid-control-file");
  await canonical(process.argv[2]); const work = await openDirectory(dirname(process.argv[2]));
  let stage: Directory | undefined, tablesDirectory: Directory | undefined, databaseParent: Directory | undefined;
  try {
    const config = request(await smallFile(work, "request.json", 16384));
    await canonical(config.databasePath); await canonical(dirname(config.mediaDirectory));
    check(join(dirname(config.mediaDirectory), basename(config.mediaDirectory)) === config.mediaDirectory && !config.mediaDirectory.includes("\0"), "unsafe-path");
    databaseParent = await openDirectory(dirname(config.databasePath), false);
    stage = await childDirectory(work, "snapshot"); check(await empty(stage), "unsafe-path");
    const parent = databaseParent;
    const guard = sourceGuard(config.databasePath, config.databaseDev, config.databaseIno, () => { verifyDirectory(work); verifyDirectory(parent); });
    const snapshot = await readSource(config.databasePath, guard, async () => {
      await notify({ phase: "source-ready" }); await awaitReadAuthorization();
    });
    guard(); await notify({ phase: "source-closed", tables: snapshot.tables.length, rows: snapshot.rowCount });
    validateBytes(snapshot);
    tablesDirectory = await childDirectory(stage, "tables", true);
    const tables: BackupManifest["tables"][number][] = [];
    for (const value of snapshot.tables) {
      guard(); const encoded = encodeTable(value.shape, value.rows), fileName = `${value.shape.name}.json`, digest = hash(encoded);
      await writeFile(tablesDirectory, fileName, encoded, guard);
      const actual = await fingerprint(tablesDirectory, fileName, guard);
      check(actual.sha256 === digest && actual.byteLength === String(encoded.length), "storage-failed");
      tables.push({ name: value.shape.name, path: `tables/${fileName}`, rowCount: String(value.rows.length), byteLength: String(encoded.length), sha256: digest });
    }
    const originalFiles = await media(snapshot, config.mediaDirectory, stage, guard);
    const manifest = encodeManifest({ ...originalFiles, tables, sequences: snapshot.sequences, appSchema:"thoughtloom-logical-6" });
    await writeFile(stage, "manifest.json", manifest, guard);
    const verified = await fingerprint(stage, "manifest.json", guard);
    check(verified.sha256 === hash(manifest) && verified.byteLength === String(manifest.length), "storage-failed");
    await tablesDirectory.handle.sync(); await stage.handle.sync(); guard();
    await notify({ phase: "complete", manifestSha256: verified.sha256 });
  } finally { await Promise.allSettled([tablesDirectory?.handle.close(), stage?.handle.close(), databaseParent?.handle.close(), work.handle.close()]); }
}
try { await main(); } catch (error) {
  const code = error instanceof BackupSchemaError ? "unsupported-schema" :
    error instanceof BackupCaptureError && workerFailureCodes.has(error.code) ? error.code : "capture-failed";
  await notify({ phase: "failed", code }); process.exitCode = 1;
}
