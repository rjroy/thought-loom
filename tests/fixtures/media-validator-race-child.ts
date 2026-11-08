// Controlled process-lifecycle fixture: it deliberately does not parse media.
export {};
const mode = process.argv[2];
if (mode === "early-exit") {
  // Ensure the parent entered its first flush before closing the pipe.
  const reader = Bun.stdin.stream().getReader();
  await reader.read();
  process.stderr.write("private-sentinel-worker-diagnostic");
  process.exit(7);
}
let length = 0;
for await (const part of Bun.stdin.stream()) length += part.byteLength;
if (length === 0) process.exit(2);
process.stdout.write('{"ok":true,"mimeType":"image/png"}');
