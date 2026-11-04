import { describe, expect, test } from "bun:test";
import { parseEnvelope, ProtocolValidationError } from "../src/domain/run-protocol";

describe("strict daemon capability envelope", () => {
  test("accepts exactly one capability request or one final reply", () => {
    expect(parseEnvelope('{"version":1,"kind":"request","request":{"capability":"inspectThought","arguments":{"thoughtId":"note-1"}}}')).toEqual({ version: 1, kind: "request", request: { capability: "inspectThought", arguments: { thoughtId: "note-1" } } });
    expect(parseEnvelope('{"version":1,"kind":"complete","reply":"Human-facing reply"}')).toEqual({ version: 1, kind: "complete", reply: "Human-facing reply" });
  });

  test("rejects truncated, multiple, malformed or ambiguous envelopes without creating fallback output", () => {
    for (const input of [
      '{"version":1,"kind":"complete","reply":"partial',
      '[{"version":1,"kind":"complete","reply":"one"},{"version":1,"kind":"complete","reply":"two"}]',
      '{"version":1,"kind":"request","request":{"capability":"inspectThought","arguments":{}},"reply":"also reply"}',
      '{"version":1,"kind":"complete","reply":"reply","extra":true}',
      '{"version":1,"kind":"request","id":"model-picked-op","request":{"capability":"inspectThought","arguments":{}}}',
      '{"version":1,"kind":"request","request":{"id":"model-picked-op","capability":"inspectThought","arguments":{}}}',
      '{"version":1,"kind":"request","request":{"capability":"inspectThought","arguments":[]}}',
      '{"version":2,"kind":"complete","reply":"reply"}',
      '{"kind":"complete","reply":"reply"}',
      '{"version":1,"kind":"unknown","reply":"reply"}',
    ]) expect(() => parseEnvelope(input)).toThrow(ProtocolValidationError);
  });
});
