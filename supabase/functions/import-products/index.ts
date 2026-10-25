import { activeRestaurantRole, requireAal2, verifyActor } from "../_shared/auth.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, databaseApiError } from "../_shared/errors.ts";
import { readJson, safeLog, serve } from "../_shared/http.ts";
import { importProductsSchema, parseInput } from "../_shared/schemas.ts";

const MAX_BODY_BYTES = 2 * 1_024 * 1_024;

const importResultSchema = z.object({
  batchId: z.string().uuid().optional(),
  summary: z.object({
    created: z.number().int().min(0),
    updated: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }).passthrough(),
  products: z.array(
    z.object({
      code: z.string(),
      rowRef: z.string().min(1).max(80).optional(),
      id: z.string().uuid(),
      outcome: z.enum(["created", "updated", "skipped"]),
    }).strict(),
  ),
  errors: z.array(
    z.object({
      row: z.number().int().min(1).optional(),
      code: z.string().regex(/^[A-Z0-9_]+$/),
      message: z.string().max(300),
    }).strict(),
  ).max(500),
}).strict();

serve({
  maxBodyBytes: MAX_BODY_BYTES,
  handler: async (request, context) => {
    const actor = await verifyActor(request);
    const input = parseInput(importProductsSchema, await readJson(request, MAX_BODY_BYTES));
    if (actor.authorization.isSuperAdmin) {
      await requireAal2(actor);
    } else if (activeRestaurantRole(actor, input.restaurantId) !== "restaurant_admin") {
      throw new ApiError(403, "FORBIDDEN", "No tenés permisos para importar el catálogo.");
    }

    const productByGroupCode = new Map(
      input.groups.map((group) => [
        group.groupCode.toLocaleLowerCase("en"),
        { productCode: group.productCode, productRowRef: group.productRowRef },
      ]),
    );
    const rows = {
      ...(input.batchId ? { batchId: input.batchId } : {}),
      products: input.products,
      optionGroups: input.groups,
      options: input.options.map((option) => ({
        ...option,
        ...productByGroupCode.get(option.groupCode.toLocaleLowerCase("en")),
      })),
    };
    const rpcMode = {
      create_or_update: "upsert",
      create_only: "create",
      skip_existing: "skip",
      update_only: "update",
    }[input.mode];

    // The user-scoped client preserves auth.uid(); the RPC repeats tenant/role checks.
    const { data, error } = await actor.client.rpc("import_products_batch", {
      p_restaurant_id: input.restaurantId,
      p_rows: rows,
      p_mode: rpcMode,
    });
    if (error) throw databaseApiError(error);
    const parsed = importResultSchema.safeParse(data);
    if (!parsed.success) throw new Error("Invalid import_products_batch response");

    safeLog("info", "catalog.imported", context.requestId, {
      actorId: actor.user.id,
      restaurantId: input.restaurantId,
      productCount: input.products.length,
      groupCount: input.groups.length,
      optionCount: input.options.length,
    });
    return {
      ...(parsed.data.batchId ? { batchId: parsed.data.batchId } : {}),
      summary: {
        created: parsed.data.summary.created,
        updated: parsed.data.summary.updated,
        skipped: parsed.data.summary.skipped,
      },
      products: parsed.data.products,
      errors: parsed.data.errors,
    };
  },
});
