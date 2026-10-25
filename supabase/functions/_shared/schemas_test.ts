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

Deno.test("SKU imports preserve text and omitted patch fields, and resolve anonymous rows", async () => {
  const input = {
    restaurantId: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
    batchId: "e26095be-96d5-4cd5-aad4-4c8cb82d510a",
    mode: "create_or_update",
    products: [
      { rowRef: "2", name: "Uno", category: "Cat", basePriceCents: 100 },
      { rowRef: "3", code: " 0001  A ", name: "Dos", category: "Cat", basePriceCents: 100 },
    ],
    groups: [{
      productRowRef: "2",
      groupCode: "G1",
      name: "Extras",
      required: false,
      minSelect: 0,
      maxSelect: 1,
    }],
  };
  const parsed = parseInput(importProductsSchema, input);
  assertEquals(parsed.products[1]?.code, "0001  A");
  assertEquals(Object.hasOwn(parsed.products[0]!, "description"), false);
  assertEquals(Object.hasOwn(parsed.products[0]!, "available"), false);
  assertEquals(Object.hasOwn(parsed.products[0]!, "promotionalPriceCents"), false);
  assertEquals(parsed.groups[0]?.productRowRef, "2");
  await assertRejects(() => parseInput(importProductsSchema, { ...input, batchId: undefined }));
  await assertRejects(() => parseInput(importProductsSchema, { ...input, mode: "update_only" }));
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...input,
      products: input.products.map((product) => ({ ...product, rowRef: "2" })),
    })
  );
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...input,
      groups: [{ ...input.groups[0], productCode: "0001  A" }],
    })
  );
  await assertRejects(() =>
    parseInput(importProductsSchema, {
      ...input,
      products: [{ ...input.products[0], code: "A\nB" }],
    })
  );
  const update = parseInput(importProductsSchema, {
    ...input,
    mode: "update_only",
    groups: [],
    products: [{ ...input.products[0], id: input.restaurantId, code: " " }],
  });
  assertEquals(update.products[0]?.code, "");
});

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

Deno.test("order validation accepts a canonical 100-unit line and rejects totals above 100", async () => {
  const parsed = parseInput(createOrderSchema, {
    ...validOrder,
    items: [{ ...validOrder.items[0], quantity: 100 }],
  });
  assertEquals(parsed.items[0]?.quantity, 100);

  await assertRejects(
    () =>
      parseInput(createOrderSchema, {
        ...validOrder,
        items: [{ ...validOrder.items[0], quantity: 101 }],
      }),
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

function uninspectableArray(length: number): unknown[] {
  const values = new Array(length);
  Object.defineProperty(values, 0, {
    get() {
      throw new Error("Collection elements must not be parsed before checking its length.");
    },
  });
  return values;
}

function invalidField(error: unknown, expectedPath: string): boolean {
  return error instanceof ApiError && error.status === 422 && error.code === "VALIDATION_ERROR" &&
    (error.details?.fields as { path: string }[] | undefined)?.[0]?.path === expectedPath;
}

Deno.test("order collection prechecks reject oversize arrays before parsing their elements", async () => {
  await assertRejects(
    () => parseInput(createOrderSchema, { ...validOrder, items: uninspectableArray(26) }),
    (error) => invalidField(error, "items"),
  );
  await assertRejects(
    () =>
      parseInput(createOrderSchema, {
        ...validOrder,
        items: [{ ...validOrder.items[0], optionIds: uninspectableArray(31) }],
      }),
    (error) => invalidField(error, "items.0.optionIds"),
  );
});

Deno.test("import prechecks all collection lengths before validating any row", async () => {
  for (
    const [field, maximum] of [["products", 500], ["groups", 2_500], ["options", 10_000]] as const
  ) {
    await assertRejects(
      () =>
        parseInput(importProductsSchema, {
          restaurantId: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
          mode: "create_only",
          products: uninspectableArray(1),
          [field]: uninspectableArray(maximum + 1),
        }),
      (error) => invalidField(error, field),
    );
  }
});

Deno.test("collection prechecks preserve readable shape errors and optional import defaults", async () => {
  for (const invalid of [null, {}, "items"]) {
    await assertRejects(
      () => parseInput(createOrderSchema, { ...validOrder, items: invalid }),
      (error) => invalidField(error, "items"),
    );
  }
  const batch = {
    restaurantId: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
    mode: "create_only",
    products: [{ code: "P1", name: "Producto", category: "General", basePriceCents: 100 }],
  };
  const parsed = parseInput(importProductsSchema, batch);
  assertEquals(parsed.groups, []);
  assertEquals(parsed.options, []);
  await assertRejects(
    () => parseInput(importProductsSchema, { ...batch, options: {} }),
    (error) => invalidField(error, "options"),
  );
});

Deno.test("order prechecks preserve the exact current line and option limits", () => {
  const optionIds = Array.from(
    { length: 30 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const parsed = parseInput(createOrderSchema, {
    ...validOrder,
    items: Array.from({ length: 25 }, () => ({ ...validOrder.items[0], quantity: 4, optionIds })),
  });
  assertEquals(parsed.items.length, 25);
  assertEquals(parsed.items[0]?.optionIds.length, 30);
});

Deno.test("import prechecks allow the exact current product, group and option limits", () => {
  const parsed = parseInput(importProductsSchema, {
    restaurantId: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
    mode: "create_only",
    products: Array.from({ length: 500 }, (_, index) => ({
      code: `P${index}`,
      name: `Producto ${index}`,
      category: "General",
      basePriceCents: 100,
    })),
    groups: Array.from({ length: 2_500 }, (_, index) => ({
      productCode: `P${Math.floor(index / 5)}`,
      groupCode: `G${index}`,
      name: "Grupo",
      required: false,
      minSelect: 0,
      maxSelect: 4,
    })),
    options: Array.from({ length: 10_000 }, (_, index) => ({
      groupCode: `G${Math.floor(index / 4)}`,
      optionCode: `O${index}`,
      name: "Opción",
      priceDeltaCents: 0,
    })),
  });
  assertEquals(parsed.products.length, 500);
  assertEquals(parsed.groups.length, 2_500);
  assertEquals(parsed.options.length, 10_000);
});
