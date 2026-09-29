import { databaseApiError, toApiError } from "./errors.ts";
import { assertEquals } from "./test-assert.ts";

Deno.test("known rate-limit database failure maps to a sanitized 429", () => {
  const mapped = databaseApiError({
    code: "P0001",
    message: "RATE_LIMITED",
    details: "private.rate_limit_buckets key value and internal SQL detail",
    hint: "secret internal hint",
  });
  assertEquals(mapped.status, 429);
  assertEquals(mapped.code, "RATE_LIMITED");
  assertEquals(mapped.message.includes("private.rate_limit_buckets"), false);
});

Deno.test("unknown errors never expose stack traces or internal messages", () => {
  const mapped = toApiError(new Error("password=not-for-a-response"));
  assertEquals(mapped.status, 500);
  assertEquals(mapped.code, "INTERNAL_ERROR");
  assertEquals(mapped.message.includes("password"), false);
});

Deno.test("disabled accounts are rejected before privileged Edge work", () => {
  const mapped = databaseApiError({
    code: "42501",
    message: "ACCOUNT_DISABLED",
    details: "profile and membership internals",
  });
  assertEquals(mapped.status, 403);
  assertEquals(mapped.code, "ACCOUNT_DISABLED");
  assertEquals(mapped.message.includes("membership"), false);
});

Deno.test("invalid import categories map to a sanitized validation error", () => {
  const mapped = databaseApiError({
    code: "P0001",
    message: "IMPORT_CATEGORY_INVALID",
    details: "internal category slug value",
  });
  assertEquals(mapped.status, 422);
  assertEquals(mapped.code, "IMPORT_CATEGORY_INVALID");
  assertEquals(mapped.message.includes("internal"), false);
});
