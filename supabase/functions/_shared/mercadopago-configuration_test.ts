import type { SupabaseClient } from "./deps.ts";
import { sha256Hex } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import { base64url, decryptCredentials } from "./mercadopago-core.ts";
import {
  beginPaymentConnection,
  exchangeAuthorizationCode,
  paymentConnectionConfiguration,
  requireMercadoPagoClientId,
} from "./mercadopago.ts";
import { assert, assertEquals, assertRejects } from "./test-assert.ts";

const actor = {
  restaurantId: "21000000-0000-4000-8000-000000000001",
  actorId: "51000000-0000-4000-8000-000000000001",
  superAdminAal2: false,
};
const key = base64url(new Uint8Array(32).fill(8));
const fixtureClientId = "1234567890123456";

async function withConfiguration(action: () => Promise<void>) {
  const values = {
    MERCADOPAGO_CLIENT_ID: fixtureClientId,
    MERCADOPAGO_CLIENT_SECRET: "secret-fixture-for-configuration",
    MERCADOPAGO_ENCRYPTION_KEY: key,
    MERCADOPAGO_WEBHOOK_SECRET: "webhook-fixture-for-configuration",
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

function fakeAdmin() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

Deno.test("invalid OAuth application IDs cannot persist state or reach Mercado Pago", async () => {
  await withConfiguration(async () => {
    const values = [
      undefined,
      "",
      "APP_USR-public-key-fixture",
      "TEST-access-token-fixture",
      "61000000-0000-4000-8000-000000000001",
      "123abc",
      "-123",
      "0",
      "0123",
      "1".repeat(33),
      "123\n456",
    ];
    let providerRequests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      providerRequests++;
      throw new Error("Unexpected provider request");
    };
    try {
      for (const value of values) {
        if (value === undefined) Deno.env.delete("MERCADOPAGO_CLIENT_ID");
        else Deno.env.set("MERCADOPAGO_CLIENT_ID", value);
        const { client, calls } = fakeAdmin();
        const safeFailure = (error: unknown) => {
          assert(error instanceof ApiError);
          assertEquals(error.status, 500);
          assertEquals(error.code, "PAYMENT_CONFIGURATION_ERROR");
          if (value) assert(!error.message.includes(value));
          return true;
        };
        await assertRejects(() => beginPaymentConnection(client, actor), safeFailure);
        await assertRejects(
          () => exchangeAuthorizationCode("code-fixture", "verifier-fixture"),
          safeFailure,
        );
        assertEquals(calls, []);
        assertEquals(paymentConnectionConfiguration(), {
          configured: false,
          configurationIssue: value ? "invalid_client_id" : "missing_configuration",
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertEquals(providerRequests, 0);
  });
});

Deno.test("connection status reports missing configuration without disclosing its values", async () => {
  await withConfiguration(async () => {
    assertEquals(paymentConnectionConfiguration(), { configured: true, configurationIssue: null });
    for (
      const name of [
        "MERCADOPAGO_CLIENT_SECRET",
        "MERCADOPAGO_ENCRYPTION_KEY",
        "MERCADOPAGO_WEBHOOK_SECRET",
      ]
    ) {
      const previous = Deno.env.get(name)!;
      Deno.env.delete(name);
      assertEquals(paymentConnectionConfiguration(), {
        configured: false,
        configurationIssue: "missing_configuration",
      });
      Deno.env.set(name, previous);
    }
  });
});

Deno.test("valid numeric application IDs stay lossless and produce one encrypted OAuth state", async () => {
  await withConfiguration(async () => {
    const longId = "12345678901234567890123456789012";
    Deno.env.set("MERCADOPAGO_CLIENT_ID", ` ${longId} `);
    assertEquals(requireMercadoPagoClientId(), longId);
    const { client, calls } = fakeAdmin();
    const result = await beginPaymentConnection(client, actor);
    const url = new URL(result.authorizationUrl);
    assertEquals(url.origin, "https://auth.mercadopago.com");
    assertEquals(url.searchParams.get("client_id"), longId);
    assertEquals(url.searchParams.get("code_challenge_method"), "S256");
    assertEquals(url.searchParams.has("client_secret"), false);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.name, "save_payment_oauth_state");
    const stateHash = await sha256Hex(url.searchParams.get("state")!);
    assertEquals(calls[0]!.args.p_state_hash, stateHash);
    const payload = await decryptCredentials(
      String(calls[0]!.args.p_encrypted_payload),
      key,
      stateHash,
    ) as Record<string, unknown>;
    assertEquals(payload.restaurantId, actor.restaurantId);
    assertEquals(payload.actorId, actor.actorId);
    assertEquals(payload.superAdminAal2, false);
    assert(typeof payload.verifier === "string");
    assert(!String(calls[0]!.args.p_encrypted_payload).includes(actor.actorId));
  });
});
