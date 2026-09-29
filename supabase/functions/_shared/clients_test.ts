import { createAdminClient } from "./clients.ts";
import { assertEquals } from "./test-assert.ts";

Deno.test("admin client sends only the explicitly selected secret key", async () => {
  const previousUrl = Deno.env.get("SUPABASE_URL");
  const previousSecret = Deno.env.get("SUPABASE_SECRET_KEYS");
  const previousSecretKeyName = Deno.env.get("APP_SECRET_KEY_NAME");
  const previousFetch = globalThis.fetch;
  let apiKey: string | null = null;
  let authorization: string | null = null;

  try {
    Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
    Deno.env.set(
      "SUPABASE_SECRET_KEYS",
      JSON.stringify({
        default: "sb_secret_default_value",
        production_2026_09_29: "sb_secret_selected_value",
      }),
    );
    Deno.env.set("APP_SECRET_KEY_NAME", "production_2026_09_29");
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      apiKey = headers.get("apikey");
      authorization = headers.get("authorization");
      return Promise.resolve(
        new Response("null", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const { error } = await createAdminClient().rpc("test_admin_rpc");

    assertEquals(error, null);
    assertEquals(apiKey, "sb_secret_selected_value");
    assertEquals(authorization, "Bearer sb_secret_selected_value");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", previousUrl);
    if (previousSecret === undefined) Deno.env.delete("SUPABASE_SECRET_KEYS");
    else Deno.env.set("SUPABASE_SECRET_KEYS", previousSecret);
    if (previousSecretKeyName === undefined) Deno.env.delete("APP_SECRET_KEY_NAME");
    else Deno.env.set("APP_SECRET_KEY_NAME", previousSecretKeyName);
  }
});
