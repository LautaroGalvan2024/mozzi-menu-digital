import { ApiError } from "./errors.ts";
import { readJson } from "./http.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("JSON reader enforces actual byte length even without Content-Length", async () => {
  const request = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "1234567890" }),
  });
  await assertRejects(
    () => readJson(request, 8),
    (error) => error instanceof ApiError && error.status === 413,
  );
});

Deno.test("JSON reader rejects non-JSON media types", async () => {
  const request = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  await assertRejects(
    () => readJson(request, 1_024),
    (error) => error instanceof ApiError && error.status === 415,
  );
});

Deno.test("JSON reader returns parsed objects", async () => {
  const request = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"ok":true}',
  });
  assertEquals(await readJson(request, 1_024), { ok: true });
});
