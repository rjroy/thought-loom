import { expect, test } from "bun:test";
import { commandId } from "../../apps/web/lib/command-id";

test.each([
  { bytes: [0, 1, 2, 3, 4, 5, 0xff, 7, 0xff, 9, 10, 11, 12, 13, 14, 15], expected: "00010203-0405-4f07-bf09-0a0b0c0d0e0f" },
  { bytes: [255, 254, 253, 252, 251, 250, 0, 248, 0, 246, 245, 244, 243, 242, 241, 240], expected: "fffefdfc-fbfa-40f8-80f6-f5f4f3f2f1f0" },
])("command IDs preserve random bytes and set UUID v4 version and variant", ({ bytes, expected }) => {
  const previous = Object.getOwnPropertyDescriptor(crypto, "getRandomValues");
  let calls = 0;
  Object.defineProperty(crypto, "getRandomValues", { configurable: true, value: (array: Uint8Array) => {
    expect(array).toBeInstanceOf(Uint8Array);
    expect(array.length).toBe(16);
    calls++;
    array.set(bytes);
    return array;
  } });
  try {
    expect(commandId()).toBe(expected);
    expect(calls).toBe(1);
  } finally {
    if (previous) Object.defineProperty(crypto, "getRandomValues", previous);
    else Reflect.deleteProperty(crypto, "getRandomValues");
  }
});
