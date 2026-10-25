import { randomToken } from "./crypto.ts";
import { ApiError } from "./errors.ts";
import { orderConfirmationResponse, parseRecoveryRequest } from "./order-confirmation.ts";
import { assert, assertEquals, assertRejects } from "./test-assert.ts";

const actionId = "d26095be-96d5-4cd5-aad4-4c8cb82d510a";
const expiry = "2026-10-25T02:00:00.000Z";
const canonical = {
  idempotentReplay: true,
  restaurant: {
    name: "Synthetic commerce",
    timezone: "America/Argentina/Buenos_Aires",
    locale: "es-AR",
    whatsappPhone: "+5491111111111",
  },
  order: {
    actionId,
    displayNumber: "SYN-000001",
    status: "generated",
    createdAt: "2026-10-25T01:30:00.000Z",
    customerName: "Synthetic customer",
    customerPhone: "+5492222222222",
    fulfillmentType: "pickup",
    subtotalCents: "1000",
    discountCents: "0",
    surchargeCents: "0",
    deliveryFeeCents: "0",
    totalCents: "1000",
    currencyCode: "ARS",
  },
  paymentMethod: { name: "Cash" },
  items: [{ name: "Synthetic product", quantity: 1, lineTotalCents: "1000", options: [] }],
  clientEventTokenStored: false,
  clientEventExpiresAt: expiry,
  recoveryTokenStored: true,
  recoveryExpiresAt: expiry,
};

Deno.test("confirmation recovery requires an opaque token as well as action ID", async () => {
  const token = randomToken(32);
  assertEquals(parseRecoveryRequest({ actionId, recoveryToken: token }), {
    actionId,
    recoveryToken: token,
  });
  for (
    const input of [
      { actionId },
      { actionId, recoveryToken: "" },
      { actionId, recoveryToken: actionId },
      { actionId: "invalid", recoveryToken: token },
      { actionId, recoveryToken: token, customerName: "unexpected" },
      { actionId, recoveryToken: "A".repeat(4096) },
    ]
  ) {
    await assertRejects(
      () => parseRecoveryRequest(input),
      (error) =>
        error instanceof ApiError && error.status === 404 &&
        error.code === "RECOVERY_NOT_AVAILABLE" &&
        error.message === "Esta confirmación no está disponible.",
    );
  }
});

Deno.test("recovery response preserves expiry and does not grant a telemetry token", () => {
  const token = randomToken(32);
  const response = orderConfirmationResponse(canonical, "https://menu.example.test", {
    clientEventToken: null,
    recoveryToken: token,
  });
  assertEquals(response.order.actionId, actionId);
  assertEquals(response.recoveryToken, token);
  assertEquals(response.recoveryExpiresAt, expiry);
  assertEquals(response.clientEventToken, null);
  assertEquals(response.idempotentReplay, true);
  assert(response.whatsapp.message.includes("Synthetic customer"));
  assert(!JSON.stringify(response.whatsapp).includes(token));
  assert(!("customerName" in response.order));
});

Deno.test("creation confirmation exposes only tokens confirmed stored by the database", () => {
  const telemetryToken = randomToken(32);
  const recoveryToken = randomToken(32);
  assert(telemetryToken !== recoveryToken);
  const response = orderConfirmationResponse(
    {
      ...canonical,
      idempotentReplay: false,
      clientEventTokenStored: true,
    },
    "https://menu.example.test",
    { clientEventToken: telemetryToken, recoveryToken },
  );
  assertEquals(response.clientEventToken, telemetryToken);
  assertEquals(response.recoveryToken, recoveryToken);
  assertEquals(response.idempotentReplay, false);
  const legacy = { ...canonical, recoveryTokenStored: false };
  const oldResponse = orderConfirmationResponse(legacy, "https://menu.example.test", {
    clientEventToken: telemetryToken,
    recoveryToken,
  });
  assert(!("recoveryToken" in oldResponse));
  assert(!("recoveryExpiresAt" in oldResponse));
});

Deno.test("invalid recovery expiry is rejected without emitting an unusable credential", async () => {
  await assertRejects(
    () =>
      orderConfirmationResponse(
        { ...canonical, recoveryExpiresAt: "invalid" },
        "https://menu.example.test",
        { clientEventToken: null, recoveryToken: randomToken(32) },
      ),
    (error) => error instanceof ApiError && error.code === "INVALID_DATABASE_RESPONSE",
  );
});
