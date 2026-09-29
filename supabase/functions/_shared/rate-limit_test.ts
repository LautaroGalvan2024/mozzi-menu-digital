import { ApiError } from "./errors.ts";
import { assertOrderRateLimitAllowed } from "./rate-limit.ts";
import { assertRejects } from "./test-assert.ts";

Deno.test("order rate-limit preflight accepts the canonical allowed result", () => {
  assertOrderRateLimitAllowed({ allowed: true, code: null });
});

Deno.test("order rate-limit preflight maps exhausted counters to 429", async () => {
  await assertRejects(
    () => assertOrderRateLimitAllowed({ allowed: false, code: "RATE_LIMITED" }),
    (error) => error instanceof ApiError && error.status === 429 && error.code === "RATE_LIMITED",
  );
});

Deno.test("order rate-limit preflight hides restaurant availability consistently", async () => {
  await assertRejects(
    () => assertOrderRateLimitAllowed({ allowed: false, code: "RESTAURANT_NOT_AVAILABLE" }),
    (error) =>
      error instanceof ApiError && error.status === 404 && error.code === "RESTAURANT_NOT_FOUND",
  );
});

Deno.test("order rate-limit preflight rejects malformed database responses", async () => {
  await assertRejects(
    () => assertOrderRateLimitAllowed({ allowed: "yes", code: null }),
    (error) => error instanceof ApiError && error.status === 500,
  );
});
