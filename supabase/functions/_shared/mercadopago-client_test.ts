import { ApiError } from "./errors.ts";
import { MercadoPagoClient } from "./mercadopago-client.ts";
import { assert, assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("provider transport preserves request contracts and rejects alternate origins", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new MercadoPagoClient((url, init) => {
    requests.push({ url, init });
    return Promise.resolve(Response.json({ id: "preference" }));
  });
  assertEquals(await client.request("/checkout/preferences", "token", { total: 20 }), {
    id: "preference",
  });
  assertEquals(requests[0]?.url, "https://api.mercadopago.com/checkout/preferences");
  assertEquals(requests[0]?.init.method, "POST");
  assertEquals(requests[0]?.init.redirect, "error");
  assertEquals(requests[0]?.init.body, '{"total":20}');
  assertEquals(new Headers(requests[0]?.init.headers).get("authorization"), "Bearer token");
  await assertRejects(() => client.request("//other.example/path", "secret"));
  assertEquals(requests.length, 1);
});

Deno.test("provider transport retains sanitized HTTP errors and OAuth mapping", async () => {
  for (const status of [409, 429, 503]) {
    const client = new MercadoPagoClient(() =>
      Promise.resolve(new Response("sensitive-provider-data", { status }))
    );
    await assertRejects(() => client.request("/v1/payments/123"), (error) => {
      assert(error instanceof ApiError);
      assertEquals(error.code, "PAYMENT_PROVIDER_ERROR");
      assertEquals(error.status, status >= 500 ? 503 : 409);
      assert(!error.message.includes("sensitive-provider-data"));
      return true;
    });
  }
  const oauth = new MercadoPagoClient(() =>
    Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }))
  );
  await assertRejects(
    () => oauth.request("/oauth/token", undefined, {}),
    (error) => error instanceof ApiError && error.code === "PAYMENT_OAUTH_INVALID_GRANT",
  );
});

Deno.test("provider transport propagates the maintenance cancellation boundary", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new MercadoPagoClient((_url, init) => {
    assert(init.signal?.aborted);
    return Promise.reject(new Error("aborted request"));
  });
  await assertRejects(
    () => client.request("/v1/payments/123", "token", undefined, "GET", controller.signal),
    (error) => error instanceof ApiError && error.code === "PAYMENT_PROVIDER_UNAVAILABLE",
  );
});
