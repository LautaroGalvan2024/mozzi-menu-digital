import type { SupabaseClient } from "./deps.ts";
import { ApiError } from "./errors.ts";
import { base64url, decryptCredentials, encryptCredentials } from "./mercadopago-core.ts";
import {
  beginPaymentCheckout,
  exchangeAuthorizationCode,
  normalizeOAuthTokenResponse,
  paymentAccount,
  paymentConnectionStatus,
  paymentReturnUrl,
  reconcileAttempt,
  reconcilePaymentNotification,
  reconcileProviderPayment,
  saveProviderAccount,
} from "./mercadopago.ts";
import { assert, assertEquals, assertRejects } from "./test-assert.ts";

const restaurantId = "21000000-0000-4000-8000-000000000001";
const attemptId = "31000000-0000-4000-8000-000000000001";
const orderId = "41000000-0000-4000-8000-000000000001";
const accountId = "51000000-0000-4000-8000-000000000001";
const account = { accountId, restaurantId, providerUserId: "123456", liveMode: false };
const attempt = {
  attemptId,
  orderId,
  restaurantId,
  accountId,
  liveMode: false,
  providerPreferenceId: "preference-fixture",
  providerPaymentId: null,
  totalCents: 10000,
  currencyCode: "ARS" as const,
  expiresAt: "2030-01-01T00:00:00Z",
  paymentStatus: "pending",
};
const providerPayment = {
  id: "payment-fixture",
  collector_id: "123456",
  external_reference: attemptId,
  transaction_amount: 100,
  currency_id: "ARS",
  status: "approved",
  date_last_updated: "2026-10-27T12:00:00-03:00",
  live_mode: false,
};
const key = base64url(new Uint8Array(32).fill(7));

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}
function fakeAdmin(handler?: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: RpcCall[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const data = handler
        ? await handler(name, args)
        : name === "get_online_payment_attempt"
        ? attempt
        : { reconciled: true };
      return { data, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

async function withEnvironment(action: () => Promise<void>) {
  const values = {
    MERCADOPAGO_MODE: "test",
    MERCADOPAGO_ENCRYPTION_KEY: key,
    MERCADOPAGO_CLIENT_ID: "1234567890123456",
    MERCADOPAGO_CLIENT_SECRET: "client-secret-fixture",
    MERCADOPAGO_WEBHOOK_SECRET: "webhook-secret-fixture",
    APP_BASE_URL: "https://mozzi.example.test",
    SUPABASE_URL: "https://supabase.example.test",
  };
  const previous = new Map(Object.keys(values).map((name) => [name, Deno.env.get(name)]));
  for (const [name, value] of Object.entries(values)) Deno.env.set(name, value);
  try {
    await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

async function encryptedAccount(
  active = true,
  expired = false,
  liveMode: boolean | "legacy" = false,
) {
  return {
    ...account,
    liveMode: liveMode === "legacy" ? null : liveMode,
    isCurrent: true,
    encryptedCredentials: await encryptCredentials(
      {
        accessToken: "access-token-fixture",
        refreshToken: "refresh-token-fixture",
        ...(liveMode === "legacy" ? {} : { liveMode }),
      },
      key,
      restaurantId,
    ),
    expiresAt: new Date(Date.now() + (expired ? -60_000 : 3_600_000)).toISOString(),
    active,
  };
}

Deno.test("OAuth code exchange requests sandbox tokens only in test mode and preserves PKCE", async () => {
  await withEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; method: string | undefined; body: unknown }[] = [];
    globalThis.fetch = (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Promise.resolve(Response.json({ access_token: "returned-token-fixture" }));
    };
    try {
      for (const mode of ["test", "production", undefined]) {
        if (mode === undefined) Deno.env.delete("MERCADOPAGO_MODE");
        else Deno.env.set("MERCADOPAGO_MODE", mode);
        assertEquals(
          await exchangeAuthorizationCode("authorization-code-fixture", "pkce-verifier-fixture"),
          {
            rawToken: { access_token: "returned-token-fixture" },
            requestedLiveMode: mode !== "test",
          },
        );
        assertEquals(requests.at(-1), {
          url: "https://api.mercadopago.com/oauth/token",
          method: "POST",
          body: {
            grant_type: "authorization_code",
            client_id: "1234567890123456",
            client_secret: "client-secret-fixture",
            code: "authorization-code-fixture",
            redirect_uri: "https://supabase.example.test/functions/v1/mercadopago-callback",
            code_verifier: "pkce-verifier-fixture",
            ...(mode === "test" ? { test_token: true } : {}),
          },
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("OAuth credentials require the configured live_mode before any account is stored", async () => {
  await withEnvironment(async () => {
    const token = {
      access_token: "APP_USR-fixture-shared-prefix",
      refresh_token: "refresh-token-fixture",
      user_id: account.providerUserId,
      expires_in: 3600,
    };
    for (const mode of ["test", "production"]) {
      Deno.env.set("MERCADOPAGO_MODE", mode);
      const expectedLiveMode = mode !== "test";
      for (const liveMode of [!expectedLiveMode, undefined]) {
        const { client, calls } = fakeAdmin();
        await assertRejects(() =>
          saveProviderAccount(client, restaurantId, { ...token, live_mode: liveMode })
        );
        assertEquals(calls, []);
      }
      const { client, calls } = fakeAdmin();
      await saveProviderAccount(client, restaurantId, { ...token, live_mode: expectedLiveMode });
      assertEquals(calls.length, 1);
      assertEquals(calls[0]!.name, "save_payment_account");
      assertEquals(calls[0]!.args.p_live_mode, expectedLiveMode);
      assertEquals(
        await decryptCredentials(String(calls[0]!.args.p_encrypted_credentials), key, restaurantId),
        {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          liveMode: expectedLiveMode,
        },
      );
    }
  });
});

Deno.test("OAuth omission uses the captured request mode without inferring an APP_USR prefix", async () => {
  await withEnvironment(async () => {
    const rawToken = {
      access_token: "APP_USR-fixture-shared-prefix",
      refresh_token: "refresh-token-fixture",
      user_id: account.providerUserId,
      expires_in: 3600,
    };
    const originalFetch = globalThis.fetch;
    try {
      for (const expectedLiveMode of [false, true]) {
        Deno.env.set("MERCADOPAGO_MODE", expectedLiveMode ? "production" : "test");
        globalThis.fetch = () => {
          // The environment may change while awaiting the provider; it is not the request's context.
          Deno.env.set("MERCADOPAGO_MODE", expectedLiveMode ? "test" : "production");
          return Promise.resolve(Response.json(rawToken));
        };
        const exchange = await exchangeAuthorizationCode("code-fixture", "verifier-fixture");
        assertEquals(exchange.requestedLiveMode, expectedLiveMode);
        const normalized = normalizeOAuthTokenResponse(
          exchange.rawToken,
          exchange.requestedLiveMode,
        );
        assertEquals(normalized.live_mode, expectedLiveMode);
        const blocked = fakeAdmin();
        await assertRejects(
          () => saveProviderAccount(blocked.client, restaurantId, normalized),
          (error) => error instanceof ApiError && error.code === "PAYMENT_ENVIRONMENT_MISMATCH",
        );
        assertEquals(blocked.calls, []);
        Deno.env.set("MERCADOPAGO_MODE", expectedLiveMode ? "production" : "test");
        const saved = fakeAdmin();
        await saveProviderAccount(saved.client, restaurantId, normalized);
        assertEquals(
          await decryptCredentials(
            String(saved.calls[0]!.args.p_encrypted_credentials),
            key,
            restaurantId,
          ),
          {
            accessToken: rawToken.access_token,
            refreshToken: rawToken.refresh_token,
            liveMode: expectedLiveMode,
          },
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("OAuth normalization rejects conflicting explicit modes and malformed values", async () => {
  const rawToken = {
    access_token: "access-token-fixture",
    refresh_token: "refresh-token-fixture",
    user_id: account.providerUserId,
    expires_in: 3600,
  };
  for (const expected of [false, true]) {
    assertEquals(
      normalizeOAuthTokenResponse({ ...rawToken, live_mode: expected }, expected).live_mode,
      expected,
    );
    await assertRejects(
      () => normalizeOAuthTokenResponse({ ...rawToken, live_mode: !expected }, expected),
      (error) => error instanceof ApiError && error.code === "PAYMENT_ENVIRONMENT_MISMATCH",
    );
    for (const malformed of [null, "false", "true", 0, 1, undefined]) {
      await assertRejects(
        () => normalizeOAuthTokenResponse({ ...rawToken, live_mode: malformed }, expected),
        (error) => error instanceof ApiError && error.code === "PAYMENT_TOKEN_RESPONSE_INVALID",
      );
    }
  }
});

Deno.test("legacy credentials and environment changes block token use before refresh or provider requests", async () => {
  await withEnvironment(async () => {
    let providerRequests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      providerRequests++;
      throw new Error("Unexpected provider call");
    };
    try {
      for (const expired of [false, true]) {
        for (const liveMode of ["legacy", true] as const) {
          const stored = await encryptedAccount(true, expired, liveMode);
          const { client, calls } = fakeAdmin(() => stored);
          await assertRejects(
            () => paymentAccount(client, { restaurantId }, true),
            (error) =>
              error instanceof ApiError &&
              error.code === (liveMode === "legacy"
                  ? "PAYMENT_ACCOUNT_RECONNECT_REQUIRED"
                  : "PAYMENT_ENVIRONMENT_MISMATCH"),
          );
          assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(providerRequests, 0);
  });
});

Deno.test("refresh omission preserves each encrypted account mode and inactive state", async () => {
  await withEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const liveMode of [false, true]) {
        Deno.env.set("MERCADOPAGO_MODE", liveMode ? "production" : "test");
        const stored = await encryptedAccount(false, true, liveMode);
        const { client, calls } = fakeAdmin((name) =>
          name === "get_payment_account" ? stored : true
        );
        let requestBody: Record<string, unknown> = {};
        globalThis.fetch = (_input, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Promise.resolve(Response.json({
            access_token: "new-access-token-fixture",
            refresh_token: "new-refresh-token-fixture",
            user_id: account.providerUserId,
            expires_in: 3600,
          }));
        };
        const result = await paymentAccount(client, { restaurantId });
        assertEquals(result.accessToken, "new-access-token-fixture");
        assertEquals(Object.hasOwn(requestBody, "test_token"), false);
        const saved = calls.find((call) => call.name === "refresh_payment_account")!;
        assertEquals(saved.args.p_account_id, accountId);
        assertEquals(saved.args.p_expected_expires_at, stored.expiresAt);
        assertEquals(saved.args.p_live_mode, liveMode);
        assertEquals(
          await decryptCredentials(String(saved.args.p_encrypted_credentials), key, restaurantId),
          {
            accessToken: "new-access-token-fixture",
            refreshToken: "new-refresh-token-fixture",
            liveMode,
          },
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("historical refresh preserves the pinned mode when the deployment changes during refresh", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount(true, true, false);
    const { client, calls } = fakeAdmin((name) => name === "get_payment_account" ? stored : true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      Deno.env.set("MERCADOPAGO_MODE", "production");
      return Promise.resolve(Response.json({
        access_token: "new-access-token-fixture",
        refresh_token: "new-refresh-token-fixture",
        user_id: account.providerUserId,
        expires_in: 3600,
      }));
    };
    try {
      const result = await paymentAccount(client, { accountId });
      assertEquals(result.liveMode, false);
      assertEquals(result.accessToken, "new-access-token-fixture");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(calls.map((call) => call.name), [
      "get_payment_account",
      "acquire_payment_account_refresh",
      "refresh_payment_account",
    ]);
  });
});

Deno.test("payment reconciliation rejects another seller or environment before database lookup", async () => {
  await withEnvironment(async () => {
    for (const patch of [{ collector_id: "other-seller" }, { live_mode: true }]) {
      const { client, calls } = fakeAdmin();
      await assertRejects(() =>
        reconcileProviderPayment(client, { ...providerPayment, ...patch }, account)
      );
      assertEquals(calls, []);
    }
  });
});

Deno.test("payment reconciliation checks canonical amount, currency and tenant before crediting", async () => {
  await withEnvironment(async () => {
    for (const patch of [{ transaction_amount: 99.99 }, { currency_id: "USD" }]) {
      const { client, calls } = fakeAdmin();
      await assertRejects(() =>
        reconcileProviderPayment(client, { ...providerPayment, ...patch }, account)
      );
      assertEquals(calls.map((call) => call.name), ["get_online_payment_attempt"]);
    }
    const { client, calls } = fakeAdmin(() => ({
      ...attempt,
      restaurantId: "21000000-0000-4000-8000-000000000002",
    }));
    await assertRejects(() => reconcileProviderPayment(client, providerPayment, account));
    assertEquals(calls.map((call) => call.name), ["get_online_payment_attempt"]);
  });
});

Deno.test("payments from another integration are ignored without changing orders", async () => {
  await withEnvironment(async () => {
    const notUuid = fakeAdmin();
    assertEquals(
      await reconcileProviderPayment(notUuid.client, {
        ...providerPayment,
        external_reference: "another-integration-reference",
      }, account),
      null,
    );
    assertEquals(notUuid.calls, []);
    const unknown = fakeAdmin(() => null);
    assertEquals(await reconcileProviderPayment(unknown.client, providerPayment, account), null);
    assertEquals(unknown.calls.map((call) => call.name), ["get_online_payment_attempt"]);
  });
});

Deno.test("browser return parameters alone cannot credit a purchase", async () => {
  await withEnvironment(async () => {
    const { client, calls } = fakeAdmin();
    const query = new URLSearchParams({
      payment_id: "payment-fixture",
      status: "approved",
      collection_status: "approved",
      external_reference: attemptId,
    });
    await assertRejects(() => reconcileProviderPayment(client, Object.fromEntries(query), account));
    assertEquals(calls, []);
    const returnUrl = new URL(paymentReturnUrl("fundas", `${orderId}&status=approved`));
    assertEquals(returnUrl.searchParams.has("status"), false);
    assertEquals(returnUrl.searchParams.get("order"), `${orderId}&status=approved`);
  });
});

Deno.test("verified provider statuses map to distinct payment events including refunds and disputes", async () => {
  await withEnvironment(async () => {
    const cases = [
      { status: "approved", expected: "approved", refunded: 0 },
      { status: "approved", expected: "partially_refunded", refunded: 25 },
      { status: "refunded", expected: "refunded", refunded: 100 },
      { status: "charged_back", expected: "charged_back", refunded: 0 },
      { status: "in_mediation", expected: "in_mediation", refunded: 0 },
      { status: "in_process", expected: "pending", refunded: 0 },
      { status: "authorized", expected: "pending", refunded: 0 },
      { status: "rejected", expected: "rejected", refunded: 0 },
      { status: "cancelled", expected: "cancelled", refunded: 0 },
    ];
    for (const value of cases) {
      const { client, calls } = fakeAdmin();
      await reconcileProviderPayment(client, {
        ...providerPayment,
        status: value.status,
        transaction_amount_refunded: value.refunded,
      }, account);
      const saved = calls.find((call) => call.name === "reconcile_online_payment");
      assert(saved);
      assertEquals(saved.args, {
        p_attempt_id: attemptId,
        p_payment_id: "payment-fixture",
        p_status: value.expected,
        p_amount_cents: 10000,
        p_currency: "ARS",
        p_provider_updated_at: providerPayment.date_last_updated,
        p_provider_data: { refundedCents: value.refunded * 100, liveMode: false, accountId },
      });
    }
  });
});

Deno.test("an empty provider search marks the attempt reconciled without inventing a payment", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount();
    const { client, calls } = fakeAdmin((name) => name === "get_payment_account" ? stored : true);
    const originalFetch = globalThis.fetch;
    const requests: { url: URL; headers: Headers }[] = [];
    globalThis.fetch = (input, init) => {
      requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return Promise.resolve(Response.json({ results: [], paging: { total: 0 } }));
    };
    try {
      await reconcileAttempt(client, attempt);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(requests.length, 1);
    assertEquals(requests[0]!.url.origin, "https://api.mercadopago.com");
    assertEquals(requests[0]!.url.searchParams.get("external_reference"), attemptId);
    assertEquals(requests[0]!.headers.get("Authorization"), "Bearer access-token-fixture");
    assertEquals(calls.map((call) => call.name), ["get_payment_account", "mark_online_reconciled"]);
    assertEquals(calls[1]!.args, { p_attempt_id: attemptId });
  });
});

Deno.test("provider failure leaves reconciliation unfinished and never credits the order", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount();
    const { client, calls } = fakeAdmin((name) => name === "get_payment_account" ? stored : true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response("provider unavailable", { status: 503 }));
    try {
      await assertRejects(
        () => reconcileAttempt(client, attempt),
        (error) => error instanceof ApiError && error.status === 503,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
  });
});

Deno.test("refreshing a disconnected account preserves inactive state for pending reconciliation", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount(false, true);
    const { client, calls } = fakeAdmin((name) => name === "get_payment_account" ? stored : true);
    const originalFetch = globalThis.fetch;
    let refreshBody: unknown;
    globalThis.fetch = (input, init) => {
      assertEquals(String(input), "https://api.mercadopago.com/oauth/token");
      refreshBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        Response.json({
          access_token: "refreshed-access-token",
          refresh_token: "refreshed-refresh-token",
          user_id: account.providerUserId,
          expires_in: 3600,
          live_mode: false,
        }),
      );
    };
    try {
      const result = await paymentAccount(client, { restaurantId });
      assertEquals(result.active, false);
      assertEquals(result.accessToken, "refreshed-access-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(refreshBody, {
      grant_type: "refresh_token",
      client_id: "1234567890123456",
      client_secret: "client-secret-fixture",
      refresh_token: "refresh-token-fixture",
    });
    const saved = calls.find((call) => call.name === "refresh_payment_account");
    assert(saved);
    assertEquals(saved.args.p_account_id, accountId);
    assertEquals(
      await decryptCredentials(String(saved.args.p_encrypted_credentials), key, restaurantId),
      {
        accessToken: "refreshed-access-token",
        refreshToken: "refreshed-refresh-token",
        liveMode: false,
      },
    );
  });
});

Deno.test("refresh cannot replace stored credentials with a token from another environment", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount(true, true);
    const { client, calls } = fakeAdmin((name) => name === "get_payment_account" ? stored : true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(Response.json({
        access_token: "refreshed-access-token",
        refresh_token: "refreshed-refresh-token",
        user_id: account.providerUserId,
        expires_in: 3600,
        live_mode: true,
      }));
    try {
      await assertRejects(
        () => paymentAccount(client, { restaurantId }),
        (error) => error instanceof ApiError && error.code === "PAYMENT_ENVIRONMENT_MISMATCH",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(calls.map((call) => call.name), [
      "get_payment_account",
      "acquire_payment_account_refresh",
    ]);
  });
});

Deno.test("refresh lease allows only one concurrent request to rotate account credentials", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount(true, true);
    let acquired = false;
    const { client, calls } = fakeAdmin((name) => {
      if (name === "get_payment_account") return stored;
      if (name === "acquire_payment_account_refresh") {
        if (acquired) return false;
        acquired = true;
        return true;
      }
      return true;
    });
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
      fetchCount++;
      return Promise.resolve(
        Response.json({
          access_token: "refreshed-access-token",
          refresh_token: "refreshed-refresh-token",
          user_id: account.providerUserId,
          expires_in: 3600,
          live_mode: false,
        }),
      );
    };
    let results: PromiseSettledResult<Awaited<ReturnType<typeof paymentAccount>>>[];
    try {
      results = await Promise.allSettled([
        paymentAccount(client, { restaurantId }),
        paymentAccount(client, { restaurantId }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) =>
      result.status === "rejected"
    ) as PromiseRejectedResult;
    assert(rejected.reason instanceof ApiError && rejected.reason.code === "PAYMENT_PREPARING");
    assertEquals(fetchCount, 1);
    assertEquals(calls.filter((call) => call.name === "refresh_payment_account").length, 1);
  });
});

Deno.test("inactive accounts cannot start a new checkout even if stored credentials remain valid", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount(false);
    const { client, calls } = fakeAdmin(() => stored);
    await assertRejects(
      () => paymentAccount(client, { restaurantId }, true),
      (error) => error instanceof ApiError && error.code === "PAYMENT_NOT_CONNECTED",
    );
    assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
  });
});

Deno.test("OAuth initiated in a different environment is rejected before exchanging the code", async () => {
  await withEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    let requested = false;
    globalThis.fetch = () => {
      requested = true;
      throw new Error("Unexpected provider request");
    };
    try {
      Deno.env.set("MERCADOPAGO_MODE", "production");
      await assertRejects(
        () => exchangeAuthorizationCode("code-fixture", "verifier-fixture", false),
        (error) => error instanceof ApiError && error.code === "PAYMENT_ENVIRONMENT_MISMATCH",
      );
      assertEquals(requested, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("production reconciliation trusts test payment detail even when search incorrectly reports live mode", async () => {
  await withEnvironment(async () => {
    Deno.env.set("MERCADOPAGO_MODE", "production");
    const stored = { ...await encryptedAccount(false), isCurrent: false };
    const { client, calls } = fakeAdmin((name, args) => {
      if (name === "get_payment_account") {
        assertEquals(args, { p_account_id: accountId });
        return stored;
      }
      return name === "get_online_payment_attempt" ? attempt : true;
    });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (input, init) => {
      requests.push(String(input));
      assertEquals(new Headers(init?.headers).get("Authorization"), "Bearer access-token-fixture");
      return Promise.resolve(
        Response.json(
          String(input).includes("/payments/search?")
            ? { results: [{ ...providerPayment, live_mode: true }] }
            : providerPayment,
        ),
      );
    };
    try {
      await reconcileAttempt(client, attempt);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(calls.map((call) => call.name), [
      "get_payment_account",
      "get_online_payment_attempt",
      "reconcile_online_payment",
      "mark_online_reconciled",
    ]);
    assertEquals(calls[2]!.args.p_provider_data, { refundedCents: 0, liveMode: false, accountId });
    assertEquals(requests.length, 2);
    assertEquals(requests[1], "https://api.mercadopago.com/v1/payments/payment-fixture");
  });
});

Deno.test("search cannot disguise a live payment as test when its authoritative detail is live", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount();
    const { client, calls } = fakeAdmin((name) =>
      name === "get_payment_account" ? stored : attempt
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) =>
      Promise.resolve(
        Response.json(
          String(input).includes("/payments/search?")
            ? { results: [{ ...providerPayment, live_mode: false }] }
            : { ...providerPayment, live_mode: true },
        ),
      );
    try {
      await assertRejects(() => reconcileAttempt(client, attempt));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
  });
});

Deno.test("all payment details must match canonical order before any search result can credit money", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount();
    const originalFetch = globalThis.fetch;
    try {
      for (
        const patch of [
          { transaction_amount: 99.99 },
          { currency_id: "USD" },
          { collector_id: "another-merchant" },
          { external_reference: "31000000-0000-4000-8000-000000000002" },
          { external_reference: "another-integration" },
          { id: "wrong-detail-id" },
          { status: "unsupported-financial-status" },
          { live_mode: undefined },
        ]
      ) {
        const { client, calls } = fakeAdmin((name) =>
          name === "get_payment_account" ? stored : attempt
        );
        globalThis.fetch = (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/payments/search") {
            return Promise.resolve(Response.json({
              results: [{ id: "valid-payment" }, { id: "invalid-payment" }],
            }));
          }
          const detail = { ...providerPayment, id: path.split("/").at(-1)! };
          return Promise.resolve(
            Response.json(detail.id === "invalid-payment" ? { ...detail, ...patch } : detail),
          );
        };
        await assertRejects(() => reconcileAttempt(client, attempt));
        // Even the valid result remains unapplied if any detail in this batch is invalid.
        assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("reconciliation deduplicates IDs and applies fully fetched details in actual chronological order", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount();
    const details: Record<string, typeof providerPayment> = {
      older: {
        ...providerPayment,
        id: "older",
        status: "rejected",
        date_last_updated: "2026-10-27T12:00:00Z",
      },
      newer: {
        ...providerPayment,
        id: "newer",
        status: "approved",
        date_last_updated: "2026-10-27T10:00:00-03:00",
      },
    };
    const fetched: string[] = [];
    const { client, calls } = fakeAdmin((name) => {
      if (name === "get_payment_account") return stored;
      if (name === "reconcile_online_payment") assertEquals(fetched.length, 2);
      return name === "get_online_payment_attempt" ? attempt : true;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/payments/search") {
        return Promise.resolve(
          Response.json({ results: [{ id: "newer" }, { id: "older" }, { id: "older" }] }),
        );
      }
      const id = path.split("/").at(-1)!;
      fetched.push(id);
      return Promise.resolve(Response.json(details[id]));
    };
    try {
      await reconcileAttempt(client, attempt);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(fetched.sort(), ["newer", "older"]);
    assertEquals(
      calls.filter((call) => call.name === "reconcile_online_payment").map((call) =>
        call.args.p_payment_id
      ),
      ["older", "newer"],
    );
    assertEquals(calls.at(-1)!.name, "mark_online_reconciled");
  });
});

Deno.test("provider pagination and oversized result sets fail before requesting details or changing money", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount();
    const originalFetch = globalThis.fetch;
    try {
      for (
        const response of [
          { results: [{ id: "fixture" }], paging: { total: 101 } },
          {
            results: Array.from({ length: 101 }, (_, index) => ({ id: String(index) })),
            paging: { total: 0 },
          },
        ]
      ) {
        let requests = 0;
        const { client, calls } = fakeAdmin(() => stored);
        globalThis.fetch = () => {
          requests++;
          return Promise.resolve(Response.json(response));
        };
        await assertRejects(() => reconcileAttempt(client, attempt));
        assertEquals(requests, 1);
        assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("payment detail requests have bounded concurrency and finish before applying the batch", async () => {
  await withEnvironment(async () => {
    const stored = await encryptedAccount();
    let active = 0;
    let maximum = 0;
    let completed = 0;
    const { client, calls } = fakeAdmin((name) => {
      if (name === "get_payment_account") return stored;
      if (name === "reconcile_online_payment") assertEquals(completed, 7);
      return name === "get_online_payment_attempt" ? attempt : true;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/payments/search") {
        return Response.json({
          results: Array.from({ length: 7 }, (_, index) => ({ id: `detail-${index}` })),
        });
      }
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      completed++;
      return Response.json({ ...providerPayment, id: path.split("/").at(-1)! });
    };
    try {
      await reconcileAttempt(client, attempt);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(maximum, 3);
    assertEquals(active, 0);
    assertEquals(completed, 7);
    assertEquals(calls.at(-1)!.name, "mark_online_reconciled");
  });
});

Deno.test("a payment cannot credit an attempt pinned to another connection or mode of the same seller", async () => {
  await withEnvironment(async () => {
    for (
      const patch of [
        { accountId: "51000000-0000-4000-8000-000000000002" },
        { liveMode: true },
      ]
    ) {
      const { client, calls } = fakeAdmin(() => ({ ...attempt, ...patch }));
      await assertRejects(() => reconcileProviderPayment(client, providerPayment, account));
      assertEquals(calls.map((call) => call.name), ["get_online_payment_attempt"]);
    }
  });
});

Deno.test("inconsistent account metadata and encrypted mode fail before any provider request", async () => {
  await withEnvironment(async () => {
    const stored = { ...await encryptedAccount(), liveMode: true };
    const { client, calls } = fakeAdmin(() => stored);
    await assertRejects(
      () => paymentAccount(client, { accountId }),
      (error) => error instanceof ApiError && error.code === "PAYMENT_ENVIRONMENT_MISMATCH",
    );
    assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
    const status = await paymentConnectionStatus(client, restaurantId);
    assertEquals(status.readyForPayments, false);
    assertEquals(status.connectionIssue, "reconnect_required");
  });
});

Deno.test("account status distinguishes production readiness without returning or refreshing credentials", async () => {
  await withEnvironment(async () => {
    Deno.env.set("MERCADOPAGO_MODE", "production");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("Status must not contact the provider");
    };
    try {
      const cases = [
        { stored: null, issue: "not_connected", mode: null, ready: false },
        {
          stored: await encryptedAccount(true, true, false),
          issue: "different_environment",
          mode: "test",
          ready: false,
        },
        {
          stored: await encryptedAccount(false, true, true),
          issue: "inactive",
          mode: "production",
          ready: false,
        },
        {
          stored: await encryptedAccount(true, true, true),
          issue: null,
          mode: "production",
          ready: true,
        },
        {
          stored: await encryptedAccount(true, false, "legacy"),
          issue: "reconnect_required",
          mode: null,
          ready: false,
        },
      ];
      for (const value of cases) {
        const { client, calls } = fakeAdmin(() => value.stored);
        const status = await paymentConnectionStatus(client, restaurantId);
        assertEquals(status.environment, "production");
        assertEquals(status.connectionEnvironment, value.mode);
        assertEquals(status.connectionIssue, value.issue);
        assertEquals(status.readyForPayments, value.ready);
        const serialized = JSON.stringify(status);
        for (
          const forbidden of [
            "access-token-fixture",
            "refresh-token-fixture",
            "encryptedCredentials",
            "accessToken",
            "refreshToken",
          ]
        ) {
          assert(!serialized.includes(forbidden));
        }
        assertEquals(calls.map((call) => call.name), ["get_payment_account"]);
      }
      Deno.env.delete("MERCADOPAGO_WEBHOOK_SECRET");
      const { client } = fakeAdmin(() => cases[3]!.stored);
      assertEquals((await paymentConnectionStatus(client, restaurantId)).readyForPayments, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("webhook routes by seller and mode but trusts only provider-fetched payment and pinned attempt", async () => {
  await withEnvironment(async () => {
    Deno.env.set("MERCADOPAGO_MODE", "production");
    const stored = { ...await encryptedAccount(false), isCurrent: false };
    const { client, calls } = fakeAdmin((name) =>
      name === "get_payment_account" ? stored : attempt
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      assert(String(input).startsWith("https://api.mercadopago.com/v1/payments/"));
      return Promise.resolve(Response.json(providerPayment));
    };
    try {
      await reconcilePaymentNotification(client, {
        providerUserId: account.providerUserId,
        paymentId: providerPayment.id,
        liveMode: false,
      });
      assertEquals(calls[0]!.args, {
        p_provider_user_id: account.providerUserId,
        p_live_mode: false,
      });
      assertEquals(calls.at(-1)!.name, "reconcile_online_payment");

      const wrongMode = fakeAdmin(() => stored);
      await assertRejects(() =>
        reconcilePaymentNotification(wrongMode.client, {
          providerUserId: account.providerUserId,
          paymentId: providerPayment.id,
          liveMode: true,
        })
      );
      assertEquals(wrongMode.calls.map((call) => call.name), ["get_payment_account"]);

      const wrongPayment = fakeAdmin(() => stored);
      await assertRejects(
        () =>
          reconcilePaymentNotification(wrongPayment.client, {
            providerUserId: account.providerUserId,
            paymentId: "different-payment",
            liveMode: false,
          }),
        (error) =>
          error instanceof Error && error.message === "Provider notification payment mismatch",
      );
      assertEquals(wrongPayment.calls.map((call) => call.name), ["get_payment_account"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("checkout validates encrypted account before reserving and pins the exact preflight connection", async () => {
  await withEnvironment(async () => {
    const validAccount = await encryptedAccount();
    const checkoutAttempt = { ...attempt, checkoutUrl: null };
    function checkoutClient(stored: unknown, savedAttempt: unknown = checkoutAttempt) {
      const admin = fakeAdmin((name) => name === "get_payment_account" ? stored : savedAttempt);
      const builder = {
        select(column: string) {
          assertEquals(column, "id");
          return builder;
        },
        eq(column: string, value: string) {
          assertEquals([column, value], ["slug", "demo"]);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: { id: restaurantId }, error: null }),
      };
      (admin.client as unknown as Record<string, unknown>).from = (table: string) => {
        assertEquals(table, "restaurants");
        return builder;
      };
      return admin;
    }
    const input = {
      request: { restaurantSlug: " Demo " },
      ipHash: "ip-fixture",
      phoneHash: "phone-fixture",
      clientEventTokenHash: "event-hash-fixture",
      statusTokenHash: "status-hash-fixture",
    };
    for (
      const stored of [
        null,
        { ...validAccount, encryptedCredentials: "invalid-envelope" },
        { ...validAccount, liveMode: true },
        { ...validAccount, active: false },
        { ...validAccount, isCurrent: false },
        await encryptedAccount(true, false, "legacy"),
      ]
    ) {
      const admin = checkoutClient(stored);
      await assertRejects(() => beginPaymentCheckout(admin.client, input));
      assertEquals(admin.calls.map((call) => call.name), ["get_payment_account"]);
    }
    const admin = checkoutClient(validAccount);
    const result = await beginPaymentCheckout(admin.client, input);
    assertEquals(result.attempt, checkoutAttempt);
    assertEquals(admin.calls.map((call) => call.name), [
      "get_payment_account",
      "begin_online_checkout",
    ]);
    assertEquals(admin.calls[1]!.args, {
      p_request: input.request,
      p_ip_hash: input.ipHash,
      p_phone_hash: input.phoneHash,
      p_client_event_token_hash: input.clientEventTokenHash,
      p_status_token_hash: input.statusTokenHash,
      p_live_mode: false,
      p_expected_account_id: accountId,
    });
    const previousConnection = "51000000-0000-4000-8000-000000000002";
    const replay = {
      ...checkoutAttempt,
      accountId: previousConnection,
      checkoutUrl: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=historical-fixture",
    };
    const replayAdmin = checkoutClient(validAccount, replay);
    assertEquals((await beginPaymentCheckout(replayAdmin.client, input)).attempt, replay);
    for (
      const rejectedReplay of [
        { ...replay, checkoutUrl: null },
        { ...replay, liveMode: true },
        { ...replay, restaurantId: "21000000-0000-4000-8000-000000000002" },
      ]
    ) {
      const replayAdmin = checkoutClient(validAccount, rejectedReplay);
      await assertRejects(() => beginPaymentCheckout(replayAdmin.client, input));
    }
  });
});

Deno.test("legacy webhook without mode cannot use an ambiguous account or default to the deployment mode", async () => {
  await withEnvironment(async () => {
    const { client, calls } = fakeAdmin(() => null);
    await assertRejects(() =>
      reconcilePaymentNotification(client, {
        providerUserId: account.providerUserId,
        paymentId: providerPayment.id,
      })
    );
    assertEquals(calls, [{
      name: "get_payment_account",
      args: { p_provider_user_id: account.providerUserId },
    }]);
  });
});
