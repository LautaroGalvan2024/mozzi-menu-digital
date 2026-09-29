import { constantTimeEqual, hmacSha256Hex, randomToken, sha256Hex } from "./crypto.ts";
import { assert, assertEquals } from "./test-assert.ts";

Deno.test("hash helpers are deterministic and do not retain identifiers", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const first = await hmacSha256Hex("a sufficiently long test-only secret", "ip:203.0.113.5");
  const second = await hmacSha256Hex("a sufficiently long test-only secret", "ip:203.0.113.5");
  assertEquals(first, second);
  assert(!first.includes("203.0.113.5"));
});

Deno.test("opaque event tokens are URL-safe and comparisons reject differences", () => {
  const token = randomToken();
  assert(/^[A-Za-z0-9_-]{40,}$/.test(token));
  assert(constantTimeEqual("same", "same"));
  assert(!constantTimeEqual("same", "different"));
});
