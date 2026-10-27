import { hmacSha256Hex, randomToken } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import {
  assertCheckoutUrl,
  decryptCredentials,
  encryptCredentials,
  paymentAmountCents,
  pkceChallenge,
  verifyPaymentSignature,
} from "./mercadopago-core.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("payment credentials are encrypted and bound to their commerce", async () => {
  const key = randomToken(32);
  const payload = { accessToken: "private-example", refreshToken: "refresh-example" };
  const encrypted = await encryptCredentials(payload, key, "commerce-a");
  assertEquals(encrypted.includes(payload.accessToken), false);
  assertEquals(await decryptCredentials(encrypted, key, "commerce-a"), payload);
  await assertRejects(() => decryptCredentials(encrypted, key, "commerce-b"));
  await assertRejects(() => decryptCredentials(encrypted, randomToken(32), "commerce-a"));
});

Deno.test("PKCE S256 matches RFC7636 known vector", async () => {
  assertEquals(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

Deno.test("payment signatures require exact resource, signed request and fresh timestamp", async () => {
  const now = 1_800_000_000_000;
  const secret = "test-webhook-secret-not-used-in-production";
  const signature = await hmacSha256Hex(secret, `id:123;request-id:request-123;ts:${now};`);
  const request = new Request("https://example.test?data.id=123", {
    headers: { "x-request-id": "request-123", "x-signature": `ts=${now},v1=${signature}` },
  });
  await verifyPaymentSignature(request, "123", secret, now);
  await assertRejects(
    () => verifyPaymentSignature(request, "124", secret, now),
    (e) => e instanceof ApiError && e.status === 401,
  );
  await assertRejects(() => verifyPaymentSignature(request, "123", secret, now + 301_000));
  await assertRejects(() =>
    verifyPaymentSignature(new Request("https://example.test"), "123", secret, now)
  );
  const duplicate = new Request(request, {
    headers: {
      "x-request-id": "request-123",
      "x-signature": `ts=${now},ts=${now},v1=${signature}`,
    },
  });
  await assertRejects(() => verifyPaymentSignature(duplicate, "123", secret, now));
});

Deno.test("checkout redirect only accepts Mercado Pago HTTPS without credentials", async () => {
  assertEquals(
    assertCheckoutUrl("https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123"),
    "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123",
  );
  for (
    const bad of [
      "http://www.mercadopago.com.ar/",
      "https://mercadopago.com.ar.attacker.test/",
      "https://attacker.test/",
      "https://user:pass@www.mercadopago.com.ar/",
      "javascript:alert(1)",
    ]
  ) {
    await assertRejects(() => assertCheckoutUrl(bad));
  }
});

Deno.test("payment amount is compared as exact canonical cents", async () => {
  assertEquals(paymentAmountCents(19.99), 1999);
  assertEquals(paymentAmountCents(0.29), 29);
  for (const bad of [NaN, Infinity, -1, 1.001, Number.MAX_SAFE_INTEGER]) {
    await assertRejects(() => paymentAmountCents(bad));
  }
});
