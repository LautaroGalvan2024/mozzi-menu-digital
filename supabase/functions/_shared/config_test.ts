import { getPublishableKey, getSecretKey } from "./config.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("modern injected Supabase key maps use the configured secret key name", () => {
  const previousPublishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const previousSecret = Deno.env.get("SUPABASE_SECRET_KEYS");
  const previousSecretKeyName = Deno.env.get("APP_SECRET_KEY_NAME");
  try {
    Deno.env.set(
      "SUPABASE_PUBLISHABLE_KEYS",
      JSON.stringify({ default: "sb_publishable_test_value", rotated: "sb_publishable_other" }),
    );
    Deno.env.set(
      "SUPABASE_SECRET_KEYS",
      JSON.stringify({
        default: "sb_secret_test_value",
        production_2026_09_29: "sb_secret_other",
      }),
    );
    assertEquals(getPublishableKey(), "sb_publishable_test_value");
    Deno.env.set("APP_SECRET_KEY_NAME", "default");
    assertEquals(getSecretKey(), "sb_secret_test_value");
    Deno.env.set("APP_SECRET_KEY_NAME", "production_2026_09_29");
    assertEquals(getSecretKey(), "sb_secret_other");
  } finally {
    if (previousPublishable === undefined) Deno.env.delete("SUPABASE_PUBLISHABLE_KEYS");
    else Deno.env.set("SUPABASE_PUBLISHABLE_KEYS", previousPublishable);
    if (previousSecret === undefined) Deno.env.delete("SUPABASE_SECRET_KEYS");
    else Deno.env.set("SUPABASE_SECRET_KEYS", previousSecret);
    if (previousSecretKeyName === undefined) Deno.env.delete("APP_SECRET_KEY_NAME");
    else Deno.env.set("APP_SECRET_KEY_NAME", previousSecretKeyName);
  }
});

Deno.test("legacy or malformed injected key maps fail without exposing their contents", async () => {
  const previousPublishable = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const previousSecret = Deno.env.get("SUPABASE_SECRET_KEYS");
  const previousSecretKeyName = Deno.env.get("APP_SECRET_KEY_NAME");
  try {
    Deno.env.set("SUPABASE_PUBLISHABLE_KEYS", JSON.stringify({ default: "eyJlegacy" }));
    Deno.env.set("SUPABASE_SECRET_KEYS", "not-json-with-sensitive-content");
    Deno.env.set("APP_SECRET_KEY_NAME", "default");
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
    if (previousSecretKeyName === undefined) Deno.env.delete("APP_SECRET_KEY_NAME");
    else Deno.env.set("APP_SECRET_KEY_NAME", previousSecretKeyName);
  }
});

Deno.test("secret key selection fails closed for missing or invalid names", async () => {
  const previousSecret = Deno.env.get("SUPABASE_SECRET_KEYS");
  const previousSecretKeyName = Deno.env.get("APP_SECRET_KEY_NAME");
  try {
    Deno.env.set(
      "SUPABASE_SECRET_KEYS",
      JSON.stringify({ default: "sb_secret_sensitive_value" }),
    );
    Deno.env.delete("APP_SECRET_KEY_NAME");
    await assertRejects(
      () => getSecretKey(),
      (error) =>
        error instanceof Error && error.message.includes("APP_SECRET_KEY_NAME") &&
        !error.message.includes("sensitive_value"),
    );

    for (const invalidName of ["Invalid-Name", "1abc", "abc", `a${"b".repeat(64)}`]) {
      Deno.env.set("APP_SECRET_KEY_NAME", invalidName);
      await assertRejects(
        () => getSecretKey(),
        (error) => error instanceof Error && error.message.includes("4-64"),
      );
    }

    Deno.env.set("APP_SECRET_KEY_NAME", "missing_key");
    await assertRejects(
      () => getSecretKey(),
      (error) =>
        error instanceof Error && error.message.includes("missing_key") &&
        !error.message.includes("sensitive_value"),
    );
  } finally {
    if (previousSecret === undefined) Deno.env.delete("SUPABASE_SECRET_KEYS");
    else Deno.env.set("SUPABASE_SECRET_KEYS", previousSecret);
    if (previousSecretKeyName === undefined) Deno.env.delete("APP_SECRET_KEY_NAME");
    else Deno.env.set("APP_SECRET_KEY_NAME", previousSecretKeyName);
  }
});
