import { importProductsSchema, parseInput } from "./schemas.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

const base = {
  restaurantId: "d26095be-96d5-4cd5-aad4-4c8cb82d510a",
  batchId: "e26095be-96d5-4cd5-aad4-4c8cb82d510a",
  mode: "create_or_update",
  products: [{
    rowRef: "2",
    code: "F-N",
    name: "Negra",
    category: "Fundas",
    basePriceCents: 100,
    familyCode: "F",
    familyName: "Funda",
    variantAttributes: { Color: "Negro" },
  }],
};
Deno.test("variant imports preserve grouping through Edge validation", () => {
  const result = parseInput(importProductsSchema, base);
  assertEquals(result.products[0]?.variantAttributes, { Color: "Negro" });
  assertEquals(result.products[0]?.familyCode, "F");
});
Deno.test("variant imports reject incomplete groups, non-text values and duplicate axes", async () => {
  for (
    const patch of [
      { familyName: undefined },
      { familyCode: undefined },
      { variantAttributes: {} },
      { variantAttributes: { Color: 1 } },
      { variantAttributes: { Color: "Negro", color: "Rojo" } },
    ]
  ) {
    await assertRejects(() =>
      parseInput(importProductsSchema, { ...base, products: [{ ...base.products[0], ...patch }] })
    );
  }
});
