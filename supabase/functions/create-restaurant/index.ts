import { requireSuperAdmin } from "../_shared/auth.ts";
import { createAdminClient } from "../_shared/clients.ts";
import { getAppBaseUrl } from "../_shared/config.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, databaseApiError } from "../_shared/errors.ts";
import { jsonResponse, safeLog, serve } from "../_shared/http.ts";
import { RestaurantInvitations } from "../_shared/invitations.ts";
import { createRestaurantSchema, parseInput } from "../_shared/schemas.ts";

const transactionResultSchema = z.object({
  restaurant: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    status: z.enum(["draft", "active", "suspended"]),
  }).passthrough(),
  membership: z.object({
    userId: z.string().uuid(),
    role: z.literal("restaurant_admin"),
    status: z.enum(["invited", "active", "suspended"]),
  }).passthrough(),
  idempotentReplay: z.boolean().optional().default(false),
}).passthrough();

serve({
  name: "create-restaurant",
  maxBodyBytes: 32 * 1_024,
  handler: async (request, context) => {
    const actor = await requireSuperAdmin(request);
    const input = parseInput(createRestaurantSchema, await context.readJson());

    // The privileged client is deliberately created only after verified Auth, role, and AAL2.
    const admin = createAdminClient();
    const appBaseUrl = getAppBaseUrl();
    const invitations = new RestaurantInvitations(admin);
    const user = await invitations.resolve(input.administrator.email, input.administrator.fullName);
    const membershipStatus = user.email_confirmed_at ? "active" : "invited";

    const { data, error } = await admin.rpc("create_restaurant_transaction", {
      p_payload: {
        ...input,
        adminName: input.administrator.fullName,
        createDefaultPaymentMethods: input.createBasicPaymentMethods,
        administrator: {
          ...input.administrator,
          invitationSent: false,
          membershipStatus,
        },
      },
      p_actor_id: actor.user.id,
      p_admin_user_id: user.id,
      p_admin_email: input.administrator.email,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw databaseApiError(error);

    const parsed = transactionResultSchema.safeParse(data);
    if (!parsed.success) throw new Error("Invalid create_restaurant_transaction response");
    const restaurant = parsed.data.restaurant;
    if (parsed.data.membership.userId !== user.id || restaurant.slug !== input.slug) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "La clave de reintento ya fue utilizada para otra creación.",
      );
    }

    const delivery = parsed.data.membership.status === "invited"
      ? await invitations.deliver(
        restaurant.id,
        user.id,
        appBaseUrl + "/auth/callback?next=%2Fauth%2Fset-password",
        "restaurant_admin",
      )
      : { invitationSent: false, deliveryPending: false };
    safeLog(delivery.deliveryPending ? "warn" : "info", "restaurant.created", context.requestId, {
      actorId: actor.user.id,
      restaurantId: restaurant.id,
      deliveryPending: delivery.deliveryPending,
      idempotentReplay: parsed.data.idempotentReplay,
    });
    return jsonResponse({
      restaurant,
      administrator: {
        userId: user.id,
        ...delivery,
        membershipStatus: parsed.data.membership.status,
      },
      idempotentReplay: parsed.data.idempotentReplay,
    }, parsed.data.idempotentReplay ? 200 : 201);
  },
});
