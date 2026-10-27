import type { SupabaseClient } from "./deps.ts";
import { ApiError } from "./errors.ts";
import { base64url, decryptCredentials, encryptCredentials } from "./mercadopago-core.ts";
import {
  exchangeAuthorizationCode,
  paymentAccount,
  paymentReturnUrl,
  reconcileAttempt,
  reconcileProviderPayment,
  saveProviderAccount,
} from "./mercadopago.ts";
import { assert, assertEquals, assertRejects } from "./test-assert.ts";

const restaurantId = "21000000-0000-4000-8000-000000000001";
const attemptId = "31000000-0000-4000-8000-000000000001";
const orderId = "41000000-0000-4000-8000-000000000001";
const account = { restaurantId, providerUserId: "123456" };
const attempt = {
  attemptId,
  orderId,
  restaurantId,
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

async function encryptedAccount(active = true, expired = false) {
  return {
    ...account,
    encryptedCredentials: await encryptCredentials(
      { accessToken: "access-token-fixture", refreshToken: "refresh-token-fixture" },
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
          { access_token: "returned-token-fixture" },
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
      assertEquals(calls[0]!.args.p_activate, true);
      assertEquals(
        await decryptCredentials(String(calls[0]!.args.p_encrypted_credentials), key, restaurantId),
        { accessToken: token.access_token, refreshToken: token.refresh_token },
      );
    }
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
        p_provider_data: { refundedCents: value.refunded * 100 },
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
    const saved = calls.find((call) => call.name === "save_payment_account");
    assert(saved);
    assertEquals(saved.args.p_activate, false);
    assertEquals(
      await decryptCredentials(String(saved.args.p_encrypted_credentials), key, restaurantId),
      { accessToken: "refreshed-access-token", refreshToken: "refreshed-refresh-token" },
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
    assertEquals(calls.filter((call) => call.name === "save_payment_account").length, 1);
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
