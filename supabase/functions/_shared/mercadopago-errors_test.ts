import type { SupabaseClient } from "./deps.ts";
import { ApiError } from "./errors.ts";
import {
  oauthCallbackMessage,
  safeOAuthProviderMetadata,
  safeTokenResponseMetadata,
} from "./mercadopago-errors.ts";
import { providerRequest, saveProviderAccount } from "./mercadopago.ts";
import { assert, assertEquals } from "./test-assert.ts";

const secretFixture = "DO_NOT_REFLECT_PROVIDER_SECRET_FIXTURE";
const tokenFixture = {
  access_token: secretFixture,
  refresh_token: secretFixture,
  user_id: 123456,
  expires_in: 3600,
  live_mode: false,
};

async function requestFailure(response: Response, path = "/oauth/token"): Promise<ApiError> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(response);
  try {
    await providerRequest(path, undefined, { code: "code-fixture" });
  } catch (error) {
    assert(error instanceof ApiError);
    return error;
  } finally {
    globalThis.fetch = originalFetch;
  }
  throw new Error("Expected provider rejection");
}

function assertNoReflectedSecret(error: ApiError) {
  assert(
    !JSON.stringify({
      code: error.code,
      message: error.message,
      details: error.details,
      publicMessage: oauthCallbackMessage(error),
      logMetadata: { ...safeOAuthProviderMetadata(error), ...safeTokenResponseMetadata(error) },
    }).includes(secretFixture),
  );
}

Deno.test("OAuth invalid_client exposes an actionable safe reason without provider descriptions", async () => {
  const error = await requestFailure(Response.json({
    error: "invalid_client",
    error_description: secretFixture,
    message: secretFixture,
    cause: [{ token: secretFixture }],
    client_secret: secretFixture,
  }, { status: 400 }));
  assertEquals(error.code, "PAYMENT_OAUTH_INVALID_CLIENT");
  assertEquals(error.details, { providerStatus: 400, providerError: "invalid_client" });
  assert(error.message.includes("Client ID y Client Secret"));
  assertEquals(oauthCallbackMessage(error), error.message);
  assertNoReflectedSecret(error);
});

Deno.test("OAuth grant, request, permission and throttling failures retain only approved enums", async () => {
  for (
    const [providerError, expected] of [
      ["invalid_grant", "PAYMENT_OAUTH_INVALID_GRANT"],
      ["invalid_request", "PAYMENT_OAUTH_INVALID_REQUEST"],
      ["unauthorized_client", "PAYMENT_OAUTH_UNAUTHORIZED_CLIENT"],
      ["invalid_scope", "PAYMENT_OAUTH_INVALID_SCOPE"],
      ["unsupported_grant_type", "PAYMENT_OAUTH_UNSUPPORTED_GRANT_TYPE"],
      ["forbidden", "PAYMENT_OAUTH_FORBIDDEN"],
      ["local_rate_limited", "PAYMENT_OAUTH_RATE_LIMITED"],
    ] as const
  ) {
    const status = providerError === "local_rate_limited" ? 429 : 400;
    const error = await requestFailure(Response.json({ error: providerError }, { status }));
    assertEquals(error.code, expected);
    assertEquals(error.status, status === 429 ? 503 : 409);
    assertEquals(safeOAuthProviderMetadata(error), { providerStatus: status, providerError });
    assertEquals(oauthCallbackMessage(error), error.message);
  }
});

Deno.test("unknown or malformed OAuth errors remain generic and cannot reflect malicious values", async () => {
  for (
    const body of [
      JSON.stringify({ error: secretFixture, error_description: secretFixture }),
      JSON.stringify({ error: { invalid_client: secretFixture } }),
      JSON.stringify({ error: "__proto__", message: secretFixture }),
      `invalid JSON ${secretFixture}`,
    ]
  ) {
    const error = await requestFailure(new Response(body, { status: 502 }));
    assertEquals(error.code, "PAYMENT_PROVIDER_ERROR");
    assertEquals(error.details, { providerStatus: 502, providerError: "unknown" });
    assertNoReflectedSecret(error);
  }
  const forged = new ApiError(400, "PAYMENT_OAUTH_INVALID_CLIENT", secretFixture, {
    providerStatus: secretFixture,
    providerError: secretFixture,
    extra: secretFixture,
  });
  assertEquals(safeOAuthProviderMetadata(forged), {});
  assert(!oauthCallbackMessage(forged).includes(secretFixture));
});

Deno.test("OAuth error reader cancels after 8 KiB without awaiting a hanging cancellation", async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(chunks === 1 ? 8192 : 1).fill(32));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
  const error = await requestFailure(new Response(body, { status: 400 }));
  assertEquals(error.code, "PAYMENT_PROVIDER_ERROR");
  assertEquals(cancelled, true);
  assertEquals(chunks, 2);
});

Deno.test("OAuth error reader rejects an oversized declared body before reading and accepts the exact bound", async () => {
  let pulled = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      pulled = true;
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const error = await requestFailure(
    new Response(body, {
      status: 400,
      headers: { "content-length": "8193" },
    }),
  );
  assertEquals(error.code, "PAYMENT_PROVIDER_ERROR");
  assertEquals(pulled, false);
  assertEquals(cancelled, true);
  const exact = await requestFailure(
    new Response(JSON.stringify({ error: "invalid_client" }).padEnd(8192), { status: 400 }),
  );
  assertEquals(exact.code, "PAYMENT_OAUTH_INVALID_CLIENT");
});

Deno.test("non-OAuth provider errors retain existing generic behavior", async () => {
  const error = await requestFailure(
    Response.json({ error: "invalid_client", message: secretFixture }, { status: 400 }),
    "/v1/payments",
  );
  assertEquals(error.code, "PAYMENT_PROVIDER_ERROR");
  assertEquals(error.details, undefined);
  assertNoReflectedSecret(error);
});

Deno.test("invalid token responses report only field presence and types before any account write", async () => {
  const invalid = {
    ...tokenFixture,
    refresh_token: undefined,
    expires_in: secretFixture,
    live_mode: undefined,
    user_id: { value: secretFixture },
  };
  let writes = 0;
  const admin = {
    rpc: () => {
      writes++;
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  try {
    await saveProviderAccount(admin, "21000000-0000-4000-8000-000000000001", invalid);
    throw new Error("Expected invalid token failure");
  } catch (error) {
    assert(error instanceof ApiError);
    assertEquals(error.code, "PAYMENT_TOKEN_RESPONSE_INVALID");
    assertEquals(error.details, {
      accessTokenPresent: true,
      refreshTokenPresent: true,
      expiresInType: "string",
      liveModeType: "undefined",
      userIdType: "object",
      invalidFields: "refresh_token,expires_in,live_mode,user_id",
    });
    assertNoReflectedSecret(error);
    assertEquals(safeTokenResponseMetadata(error), error.details);
    assert(oauthCallbackMessage(error).includes("credenciales incompletas"));
  }
  assertEquals(writes, 0);
});

Deno.test("invalid OAuth success JSON and forged token diagnostics never disclose provider bodies", async () => {
  const error = await requestFailure(new Response(secretFixture, { status: 200 }));
  assertEquals(error.code, "PAYMENT_TOKEN_RESPONSE_INVALID");
  assertNoReflectedSecret(error);
  const forged = new ApiError(502, "PAYMENT_TOKEN_RESPONSE_INVALID", secretFixture, {
    accessTokenPresent: secretFixture,
    refreshTokenPresent: false,
    expiresInType: secretFixture,
    liveModeType: "undefined",
    userIdType: secretFixture,
    invalidFields: `refresh_token,${secretFixture}`,
    rawBody: secretFixture,
  });
  assertEquals(safeTokenResponseMetadata(forged), {
    refreshTokenPresent: false,
    liveModeType: "undefined",
    invalidFields: "refresh_token",
  });
  assert(!oauthCallbackMessage(forged).includes(secretFixture));
});
