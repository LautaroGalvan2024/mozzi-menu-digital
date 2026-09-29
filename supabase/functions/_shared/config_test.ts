import { getPublishableKey, getSecretKey } from "./config.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("modern injected Supabase key maps expose only the named default keys", () => {
  const previousPublishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const previousSecret = Deno.env.get("SUPABASE_SECRET_KEYS");
  try {
    Deno.env.set(
      "SUPABASE_PUBLISHABLE_KEYS",
      JSON.stringify({ default: "sb_publishable_test_value", rotated: "sb_publishable_other" }),
    );
    Deno.env.set(
      "SUPABASE_SECRET_KEYS",
      JSON.stringify({ default: "sb_secret_test_value", rotated: "sb_secret_other" }),
    );
    assertEquals(getPublishableKey(), "sb_publishable_test_value");
    assertEquals(getSecretKey(), "sb_secret_test_value");
  } finally {
    if (previousPublishable === undefined) Deno.env.delete("SUPABASE_PUBLISHABLE_KEYS");
    else Deno.env.set("SUPABASE_PUBLISHABLE_KEYS", previousPublishable);
    if (previousSecret === undefined) Deno.env.delete("SUPABASE_SECRET_KEYS");
    else Deno.env.set("SUPABASE_SECRET_KEYS", previousSecret);
  }
});

Deno.test("legacy or malformed injected key maps fail without exposing their contents", async () => {
  const previousPublishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const previousSecret = Deno.env.get("SUPABASE_SECRET_KEYS");
  try {
    Deno.env.set("SUPABASE_PUBLISHABLE_KEYS", JSON.stringify({ default: "eyJlegacy" }));
    Deno.env.set("SUPABASE_SECRET_KEYS", "not-json-with-sensitive-content");
    await assertRejects(
      () => getPublishableKey(),
      (error) => error instanceof Error && !error.message.includes("eyJlegacy"),
    );
    await assertRejects(
      () => getSecretKey(),
      (error) => error instanceof Error && !error.message.includes("sensitive-content"),
    );
  } finally {
    if (previousPublishable === undefined) Deno.env.delete("SUPABASE_PUBLISHABLE_KEYS");
    else Deno.env.set("SUPABASE_PUBLISHABLE_KEYS", previousPublishable);
    if (previousSecret === undefined) Deno.env.delete("SUPABASE_SECRET_KEYS");
    else Deno.env.set("SUPABASE_SECRET_KEYS", previousSecret);
  }
});
