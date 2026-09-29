import { ApiError } from "./errors.ts";
import {
  createOrderSchema,
  createRestaurantSchema,
  importProductsSchema,
  parseInput,
} from "./schemas.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

const validOrder = {
  restaurantSlug: "Café Central",
  idempotencyKey: "b9c5e4c6-3bbc-4a61-b718-586d49f1c0f8",
  customer: { name: " Ana  Pérez ", phone: "+54 9 342 555 0123" },
  fulfillment: {
    type: "delivery",
    deliveryZoneId: "6b43a7ba-f720-48cb-a565-a318dbd6b2ca",
    address: "San Martín 123",
    city: "Rafaela",
  },
  paymentMethodId: "cf23a8e2-66c2-438e-b669-9710ad04e89c",
  items: [{
    productId: "e6b8838c-b76c-4a24-89fd-121833bf1cd3",
    quantity: 2,
    optionIds: [],
  }],
  antiSpam: { formStartedAt: new Date(Date.now() - 5_000).toISOString(), honeypot: "" },
};

Deno.test("order validation normalizes public input and rejects unknown fields", async () => {
  const parsed = parseInput(createOrderSchema, validOrder);
  assertEquals(parsed.restaurantSlug, "cafe-central");
  assertEquals(parsed.customer.name, "Ana Pérez");
  assertEquals(parsed.customer.phone, "+5493425550123");

  await assertRejects(
    () => parseInput(createOrderSchema, { ...validOrder, clientTotalCents: 1 }),
    (error) => error instanceof ApiError && error.code === "VALIDATION_ERROR",
  );
});

Deno.test("delivery validation requires server-resolvable address and zone IDs", async () => {
  await assertRejects(
    () =>
      parseInput(createOrderSchema, {
        ...validOrder,
        fulfillment: { type: "delivery" },
      }),
    (error) => error instanceof ApiError && error.code === "VALIDATION_ERROR",
  );
});

Deno.test("restaurant creation normalizes slug and rejects a configuration with no fulfillment", async () => {
  const base = {
    idempotencyKey: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
    name: "Café Central",
    slug: " Café Central ",
    tradeName: "Café Central",
    whatsappPhoneE164: "+5493425550123",
    address: "San Martín 123",
    city: "Rafaela",
    primaryColor: "#112233",
    secondaryColor: "#FFFFFF",
    deliveryEnabled: true,
    pickupEnabled: false,
    minimumOrderCents: 0,
    defaultPreparationMinutes: 30,
    administrator: { fullName: "Ada Admin", email: "ADA@EXAMPLE.INVALID" },
  };
  const parsed = parseInput(createRestaurantSchema, base);
  assertEquals(parsed.slug, "cafe-central");
  assertEquals(parsed.administrator.email, "ada@example.invalid");
  await assertRejects(() =>
    parseInput(createRestaurantSchema, {
      ...base,
      deliveryEnabled: false,
      pickupEnabled: false,
    })
  );
});

Deno.test("catalog import validates the complete frontend batch graph", async () => {
  const batch = {
    restaurantId: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
    mode: "create_or_update",
    products: [{
      code: "PIZZA",
      name: "Pizza",
      category: "Pizzas",
      basePriceCents: 10_000,
    }],
    groups: [{
      productCode: "PIZZA",
      groupCode: "SIZE",
      name: "Tamaño",
      required: true,
      minSelect: 1,
      maxSelect: 1,
    }],
    options: [{
      groupCode: "SIZE",
      optionCode: "LARGE",
      name: "Grande",
      priceDeltaCents: 2_000,
    }],
  };
  const parsed = parseInput(importProductsSchema, batch);
  assertEquals(parsed.mode, "create_or_update");
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...batch,
      groups: [...batch.groups, { ...batch.groups[0], productCode: "OTHER" }],
    })
  );
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...batch,
      groups: [{ ...batch.groups[0], productCode: "MISSING" }],
    })
  );
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...batch,
      options: [{ ...batch.options[0], groupCode: "MISSING" }],
    })
  );
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...batch,
      groups: [{ ...batch.groups[0], maxSelect: 21 }],
    })
  );
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...batch,
      products: [{ ...batch.products[0], category: "---" }],
    })
  );
});
