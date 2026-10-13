import { expect, test } from "bun:test";
import { fnv1a } from "./checksum.ts";

test("FNV-1a matches published 32-bit reference vectors", () => {
  // chongo's FNV test vectors: empty string, "a", and "foobar".
  expect(fnv1a(new TextEncoder().encode(""))).toBe("811c9dc5");
  expect(fnv1a(new TextEncoder().encode("a"))).toBe("e40c292c");
  expect(fnv1a(new TextEncoder().encode("foobar"))).toBe("bf9cf968");
});
