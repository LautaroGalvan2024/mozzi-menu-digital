import { activeRestaurantRole, requireAal2, verifyActor } from "../_shared/auth.ts";
import { createAdminClient } from "../_shared/clients.ts";
import { getAppBaseUrl } from "../_shared/config.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, databaseApiError } from "../_shared/errors.ts";
import { jsonResponse, readJson, safeLog, serve } from "../_shared/http.ts";
import { resolveOrInviteUser } from "../_shared/invitations.ts";
import { inviteRestaurantUserSchema, parseInput } from "../_shared/schemas.ts";

const membershipResultSchema = z.object({
  id: z.string().uuid().optional(),
  membershipId: z.string().uuid().optional(),
  restaurantId: z.string().uuid().optional(),
  role: z.enum(["restaurant_admin", "order_manager"]).optional(),
  status: z.enum(["invited", "active", "suspended"]).optional(),
}).passthrough();

serve({
  maxBodyBytes: 16 * 1_024,
  handler: async (request, context) => {
    const actor = await verifyActor(request);
    const input = parseInput(inviteRestaurantUserSchema, await readJson(request, 16 * 1_024));
    const role = activeRestaurantRole(actor, input.restaurantId);

    if (actor.authorization.isSuperAdmin) {
      await requireAal2(actor);
    } else if (role !== "restaurant_admin" || input.role !== "order_manager") {
      throw new ApiError(403, "FORBIDDEN", "No tenés permisos para invitar a ese rol.");
    }

    // The service credential is loaded only after tenant/role authorization above.
    const admin = createAdminClient();
    const invitation = await resolveOrInviteUser(admin, {
      email: input.email,
      fullName: input.fullName,
      redirectTo: `${getAppBaseUrl()}/auth/callback?next=${
        encodeURIComponent("/auth/set-password")
      }`,
    });
    const membershipStatus = invitation.invited || !invitation.user.email_confirmed_at
      ? "invited"
      : "active";
    const { data, error } = await admin.rpc("upsert_restaurant_membership", {
      p_restaurant_id: input.restaurantId,
      p_user_id: invitation.user.id,
      p_role: input.role,
      p_status: membershipStatus,
      p_actor_id: actor.user.id,
    });
    if (error) throw databaseApiError(error);
    const parsed = membershipResultSchema.safeParse(data);
    if (!parsed.success) throw new Error("Invalid upsert_restaurant_membership response");

    safeLog("info", "restaurant_user.invited", context.requestId, {
      actorId: actor.user.id,
      restaurantId: input.restaurantId,
      targetUserId: invitation.user.id,
      invitationSent: invitation.invited,
    });
    return jsonResponse({
      membership: {
        id: parsed.data.membershipId ?? parsed.data.id,
        restaurantId: input.restaurantId,
        userId: invitation.user.id,
        role: input.role,
        status: membershipStatus,
      },
      invitationSent: invitation.invited,
    }, invitation.invited ? 201 : 200);
  },
});
