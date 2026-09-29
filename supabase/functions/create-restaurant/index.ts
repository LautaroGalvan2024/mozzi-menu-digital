import { requireSuperAdmin } from "../_shared/auth.ts";
import { createAdminClient } from "../_shared/clients.ts";
import { getAppBaseUrl } from "../_shared/config.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, databaseApiError } from "../_shared/errors.ts";
import { jsonResponse, readJson, safeLog, serve } from "../_shared/http.ts";
import { resolveOrInviteUser } from "../_shared/invitations.ts";
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
  maxBodyBytes: 32 * 1_024,
  handler: async (request, context) => {
    const actor = await requireSuperAdmin(request);
    const input = parseInput(createRestaurantSchema, await readJson(request, 32 * 1_024));

    // The privileged client is deliberately created only after verified Auth, role, and AAL2.
    const admin = createAdminClient();
    const appBaseUrl = getAppBaseUrl();
    const invitation = await resolveOrInviteUser(admin, {
      email: input.administrator.email,
      fullName: input.administrator.fullName,
      redirectTo: `${appBaseUrl}/auth/callback?next=${encodeURIComponent("/auth/set-password")}`,
    });
    const membershipStatus = invitation.invited || !invitation.user.email_confirmed_at
      ? "invited"
      : "active";

    const { data, error } = await admin.rpc("create_restaurant_transaction", {
      p_payload: {
        ...input,
        adminName: input.administrator.fullName,
        createDefaultPaymentMethods: input.createBasicPaymentMethods,
        administrator: {
          ...input.administrator,
          invitationSent: invitation.invited,
          membershipStatus,
        },
      },
      p_actor_id: actor.user.id,
      p_admin_user_id: invitation.user.id,
      p_admin_email: input.administrator.email,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw databaseApiError(error);

    const parsed = transactionResultSchema.safeParse(data);
    if (!parsed.success) throw new Error("Invalid create_restaurant_transaction response");
    const restaurant = parsed.data.restaurant;
    if (parsed.data.membership.userId !== invitation.user.id || restaurant.slug !== input.slug) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "La clave de reintento ya fue utilizada para otra creación.",
      );
    }

    safeLog("info", "restaurant.created", context.requestId, {
      actorId: actor.user.id,
      restaurantId: restaurant.id,
      idempotentReplay: parsed.data.idempotentReplay,
    });
    return jsonResponse({
      restaurant,
      administrator: {
        userId: invitation.user.id,
        invitationSent: invitation.invited,
        membershipStatus: parsed.data.membership.status,
      },
      idempotentReplay: parsed.data.idempotentReplay,
    }, parsed.data.idempotentReplay ? 200 : 201);
  },
});
