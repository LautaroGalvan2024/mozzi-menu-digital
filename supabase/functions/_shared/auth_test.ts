import { parseBearerAuthorization } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("authenticated functions require a syntactically valid bearer credential", async () => {
  await assertRejects(
    () => parseBearerAuthorization(new Request("https://functions.example.test")),
    (error) => error instanceof ApiError && error.code === "AUTH_REQUIRED",
  );
  await assertRejects(
    () =>
      parseBearerAuthorization(
        new Request("https://functions.example.test", {
          headers: { Authorization: "Basic abc" },
        }),
      ),
    (error) => error instanceof ApiError && error.code === "INVALID_AUTH",
  );
});

Deno.test("bearer parser does not alter the token passed to official Auth verification", () => {
  const parsed = parseBearerAuthorization(
    new Request("https://functions.example.test", {
      headers: { Authorization: "Bearer header.payload.signature" },
    }),
  );
  assertEquals(parsed.token, "header.payload.signature");
  assertEquals(parsed.header, "Bearer header.payload.signature");
});
