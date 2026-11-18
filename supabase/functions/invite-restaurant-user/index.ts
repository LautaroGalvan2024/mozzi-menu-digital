import { activeRestaurantRole, requireAal2, verifyActor } from "../_shared/auth.ts";
import { createAdminClient } from "../_shared/clients.ts";
import { getAppBaseUrl } from "../_shared/config.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, databaseApiError } from "../_shared/errors.ts";
import { jsonResponse, safeLog, serve } from "../_shared/http.ts";
import { RestaurantInvitations } from "../_shared/invitations.ts";
import { inviteRestaurantUserSchema, parseInput } from "../_shared/schemas.ts";

const membershipResultSchema = z.object({
  id: z.string().uuid().optional(),
  membershipId: z.string().uuid().optional(),
  restaurantId: z.string().uuid().optional(),
  role: z.enum(["restaurant_admin", "order_manager"]).optional(),
  status: z.enum(["invited", "active", "suspended"]).optional(),
}).passthrough();

serve({
  name: "invite-restaurant-user",
  maxBodyBytes: 16 * 1_024,
  handler: async (request, context) => {
    const actor = await verifyActor(request);
    const input = parseInput(inviteRestaurantUserSchema, await context.readJson());
    const role = activeRestaurantRole(actor, input.restaurantId);

    if (actor.authorization.isSuperAdmin) {
      await requireAal2(actor);
    } else if (role !== "restaurant_admin" || input.role !== "order_manager") {
      throw new ApiError(403, "FORBIDDEN", "No tenés permisos para invitar a ese rol.");
    }

    // The service credential is loaded only after tenant/role authorization above.
    const admin = createAdminClient();
    const invitations = new RestaurantInvitations(admin);
    const redirectTo = getAppBaseUrl() + "/auth/callback?next=%2Fauth%2Fset-password";
    if ("resendUserId" in input) {
      const { data: member, error } = await admin.from("restaurant_members")
        .select("id,role,status").eq("restaurant_id", input.restaurantId)
        .eq("user_id", input.resendUserId).maybeSingle();
      if (error || !member || member.role !== input.role || member.status !== "invited") {
        throw new ApiError(409, "INVITATION_UNAVAILABLE", "La invitación ya no está disponible.");
      }
      const delivery = await invitations.deliver(
        input.restaurantId,
        input.resendUserId,
        redirectTo,
        input.role,
        true,
      );
      return jsonResponse({
        membership: { ...member, restaurantId: input.restaurantId, userId: input.resendUserId },
        ...delivery,
      }, 200);
    }
    const user = await invitations.resolve(input.email, input.fullName);
    const membershipStatus = user.email_confirmed_at ? "active" : "invited";
    const { data, error } = await admin.rpc("upsert_restaurant_membership", {
      p_restaurant_id: input.restaurantId,
      p_user_id: user.id,
      p_role: input.role,
      p_status: membershipStatus,
      p_actor_id: actor.user.id,
    });
    if (error) throw databaseApiError(error);
    const parsed = membershipResultSchema.safeParse(data);
    if (!parsed.success) throw new Error("Invalid upsert_restaurant_membership response");

    const delivery = (parsed.data.status ?? membershipStatus) === "invited"
      ? await invitations.deliver(input.restaurantId, user.id, redirectTo, input.role)
      : { invitationSent: false, deliveryPending: false };
    safeLog(
      delivery.deliveryPending ? "warn" : "info",
      "restaurant_user.invited",
      context.requestId,
      {
        actorId: actor.user.id,
        restaurantId: input.restaurantId,
        targetUserId: user.id,
        ...delivery,
      },
    );
    return jsonResponse({
      membership: {
        id: parsed.data.membershipId ?? parsed.data.id,
        restaurantId: input.restaurantId,
        userId: user.id,
        role: input.role,
        status: parsed.data.status ?? membershipStatus,
      },
      ...delivery,
    }, delivery.invitationSent ? 201 : 200);
  },
});
