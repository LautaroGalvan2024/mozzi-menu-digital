import { parseOrderResult, parseOrderRpcMetadata } from "./order-result.ts";
import { ApiError } from "./errors.ts";
import { assert, assertEquals, assertRejects } from "./test-assert.ts";
import { buildWhatsapp } from "./whatsapp.ts";

const result = {
  idempotentReplay: false,
  restaurant: {
    name: "Café Central",
    timezone: "America/Argentina/Cordoba",
    locale: "es-AR",
    whatsappPhone: "+5493425550123",
  },
  order: {
    actionId: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
    displayNumber: "#CAF-000001",
    status: "generated",
    createdAt: "2026-09-28T20:00:00.000Z",
    customerName: "Ana *Admin*",
    customerPhone: "+5493425550999",
    fulfillmentType: "pickup",
    customerNotes: "Sin sal",
    subtotalCents: "100000",
    discountCents: "10000",
    surchargeCents: "0",
    deliveryFeeCents: "0",
    totalCents: "90000",
    currencyCode: "ARS",
  },
  paymentMethod: { name: "Transferencia", transferAlias: "CAFE.PAGO" },
  items: [{
    name: "Café",
    quantity: 2,
    lineTotalCents: "100000",
    notes: null,
    options: [{ name: "Grande", priceDeltaCents: "10000" }],
  }],
};

Deno.test("canonical DB result keeps bigint cents exact within the API safe range", () => {
  const parsed = parseOrderResult(result);
  assertEquals(parsed.canonical.totalCents, 90_000);
  assertEquals(parsed.canonical.items[0]?.options[0]?.name, "Grande");
});

Deno.test("idempotent replay can safely return an order that already advanced", () => {
  const parsed = parseOrderResult({
    ...result,
    idempotentReplay: true,
    order: { ...result.order, status: "accepted" },
  });
  assertEquals(parsed.status, "accepted");
  assertEquals(parsed.idempotentReplay, true);
});

Deno.test("transactional rate limit result becomes a clear HTTP 429", async () => {
  await assertRejects(
    () => parseOrderRpcMetadata({ ok: false, code: "RATE_LIMITED" }),
    (error) => error instanceof ApiError && error.status === 429 && error.code === "RATE_LIMITED",
  );
});

Deno.test("WhatsApp link contains a server-built message and opaque claim path only", () => {
  const parsed = parseOrderResult(result);
  const whatsapp = buildWhatsapp(parsed.canonical, "https://menu.example.com");
  assert(whatsapp.url.startsWith("https://wa.me/5493425550123?text="));
  assert(whatsapp.message.includes("*TOTAL:"));
  assert(!whatsapp.message.includes("Ana *Admin*"));
  assertEquals(
    whatsapp.claimUrl,
    "https://menu.example.com/admin/pedidos/tomar/d26095be-96d5-4cd5-aad4-4c8cb82d510a",
  );
  assert(!whatsapp.claimUrl.includes("Ana"));
  assert(!whatsapp.claimUrl.includes("5550999"));
});
