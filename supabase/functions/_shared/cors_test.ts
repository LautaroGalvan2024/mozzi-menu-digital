import { parseAllowedOrigins } from "./config.ts";
import { corsHeaders, validateOrigin } from "./cors.ts";
import { ApiError } from "./errors.ts";
import { assert, assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("CORS allowlist normalizes explicit secure origins", () => {
  const origins = parseAllowedOrigins("https://menu.example.com, http://localhost:5173");
  assert(origins.has("https://menu.example.com"));
  assert(origins.has("http://localhost:5173"));
  assertEquals(origins.size, 2);
});

Deno.test("CORS configuration rejects wildcard and insecure remote origins", async () => {
  await assertRejects(() => parseAllowedOrigins("*"));
  await assertRejects(() => parseAllowedOrigins("http://menu.example.com"));
  await assertRejects(() => parseAllowedOrigins("https://menu.example.com/path"));
});

Deno.test("CORS rejects an unlisted request origin and never emits wildcard", async () => {
  const allowed = new Set(["https://menu.example.com"]);
  const accepted = new Request("https://functions.example.test", {
    method: "POST",
    headers: { Origin: "https://menu.example.com" },
  });
  assertEquals(validateOrigin(accepted, allowed), "https://menu.example.com");
  assertEquals(
    corsHeaders("https://menu.example.com").get("Access-Control-Allow-Origin"),
    "https://menu.example.com",
  );

  const rejected = new Request("https://functions.example.test", {
    method: "POST",
    headers: { Origin: "https://evil.example" },
  });
  await assertRejects(
    () => validateOrigin(rejected, allowed),
    (error) => error instanceof ApiError && error.code === "ORIGIN_NOT_ALLOWED",
  );
});

Deno.test("domain transition permits exact checkout origins and rejects lookalikes and missing origins", async () => {
  const origins = [
    "https://www.mozzi-comercio.online",
    "https://mozzi-comercio.online",
    "https://mozzi-menu-digital.vercel.app",
    "http://localhost:5173",
  ];
  const allowed = parseAllowedOrigins(origins.join(","));
  for (const origin of origins) {
    const request = new Request("https://functions.example.test/create-payment", {
      method: "POST",
      headers: { Origin: origin },
    });
    assertEquals(validateOrigin(request, allowed), origin);
    assertEquals(corsHeaders(origin).get("Access-Control-Allow-Origin"), origin);
  }
  for (
    const origin of [
      undefined,
      "null",
      "http://www.mozzi-comercio.online",
      "https://www.mozzi-comercio.online.evil.example",
      "https://mozzi-menu-digital-preview.vercel.app",
    ]
  ) {
    const request = new Request("https://functions.example.test/create-payment", {
      method: "POST",
      headers: origin ? { Origin: origin } : {},
    });
    await assertRejects(
      () => validateOrigin(request, allowed),
      (error) => error instanceof ApiError && error.code === "ORIGIN_NOT_ALLOWED",
    );
  }
});
