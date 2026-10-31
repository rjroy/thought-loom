import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seedInquiryExample } from "../tests/fixtures/seed-inquiry";

// Explicit opt-in only. A fresh, isolated example DB; never the normal data path.
const root = resolve(import.meta.dir, "..");
const examples = join(root, ".data/examples");
await mkdir(examples, { recursive: true });
const directory = await mkdtemp(join(examples, "inquiry-"));
const databasePath = join(directory, "thoughtloom.sqlite");
console.info("demo.prepare attempt", { databasePath });
try {
  seedInquiryExample(databasePath);
  console.info("demo.prepare succeeded", { databasePath, exampleOnly: true });
  console.info("Example annotations were written by the fixture, not by a live AI. Normal capture data is untouched.");
  const quotedPath = `'${databasePath.replace(/'/g, "'\\''")}'`;
  console.info(`Launch this example workspace:\nTHOUGHTLOOM_DATABASE_PATH=${quotedPath} bun dev`);
} catch {
  await rm(directory, { recursive: true, force: true });
  console.error("demo.prepare failed", { category: "example_seed_error" });
  process.exit(1);
}
