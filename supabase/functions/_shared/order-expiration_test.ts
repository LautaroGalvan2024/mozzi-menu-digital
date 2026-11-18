import { orderExpirationCutoff } from "../expire-orders/policy.ts";
import { expireOrdersSchema, parseInput } from "./schemas.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

const noon = Date.parse("2026-11-17T12:00:00Z");

Deno.test("default expiration uses the persisted deadline without adding another lifetime", () => {
  assertEquals(
    orderExpirationCutoff(parseInput(expireOrdersSchema, {}), noon),
    "2026-11-17T12:00:00.000Z",
  );
  assertEquals(
    orderExpirationCutoff(
      parseInput(expireOrdersSchema, { expirationMode: "expires_at", limit: 5 }),
      noon,
    ),
    "2026-11-17T12:00:00.000Z",
  );
});

Deno.test("explicit legacy minutes and explicit legacy default preserve old scheduler semantics", () => {
  assertEquals(
    orderExpirationCutoff(parseInput(expireOrdersSchema, { olderThanMinutes: 120 }), noon),
    "2026-11-17T10:00:00.000Z",
  );
  assertEquals(
    orderExpirationCutoff(
      parseInput(expireOrdersSchema, { olderThanMinutes: 15, limit: 100 }),
      noon,
    ),
    "2026-11-17T11:45:00.000Z",
  );
  assertEquals(
    orderExpirationCutoff(parseInput(expireOrdersSchema, { expirationMode: "legacy_grace" }), noon),
    "2026-11-17T10:00:00.000Z",
  );
});

Deno.test("expiration rejects ambiguous options and preserves existing limits", async () => {
  for (
    const input of [
      { expirationMode: "expires_at", olderThanMinutes: 120 },
      { olderThanMinutes: 0 },
      { olderThanMinutes: 43_201 },
      { limit: 5001 },
    ]
  ) await assertRejects(() => parseInput(expireOrdersSchema, input));
  assertEquals(parseInput(expireOrdersSchema, {}).limit, 500);
});
