import { type SupabaseClient, type User, z } from "./deps.ts";
import { ApiError } from "./errors.ts";

const leaseSchema = z.object({
  leaseId: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string().email(),
});

/** Coordinates Auth with the invitation recorded by the membership transaction. */
export class RestaurantInvitations {
  constructor(private readonly admin: SupabaseClient) {}

  async find(email: string): Promise<User | null> {
    const { data: id, error } = await this.admin.rpc("find_auth_user_by_email", { p_email: email });
    if (error) {
      throw new ApiError(500, "AUTH_DIRECTORY_ERROR", "No se pudo consultar el directorio.");
    }
    if (id === null) return null;
    const identifier = z.string().uuid().parse(id);
    const { data, error: lookupError } = await this.admin.auth.admin.getUserById(identifier);
    if (lookupError || !data.user || data.user.email?.toLowerCase() !== email.toLowerCase()) {
      throw new ApiError(409, "AUTH_DIRECTORY_ERROR", "No se pudo verificar el usuario.");
    }
    return data.user;
  }

  async resolve(email: string, fullName: string): Promise<User> {
    const existing = await this.find(email);
    if (existing) return existing;
    const { data, error } = await this.admin.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: { full_name: fullName },
    });
    if (!error && data.user) return data.user;
    const concurrent = await this.find(email);
    if (concurrent) return concurrent;
    throw new ApiError(502, "INVITATION_FAILED", "No se pudo preparar la invitación.");
  }

  async deliver(
    restaurantId: string,
    userId: string,
    redirectTo: string,
    expectedRole: "restaurant_admin" | "order_manager",
    resend = false,
  ) {
    let invitationSent = false;
    try {
      const { data, error } = await this.admin.rpc("claim_restaurant_invitation", {
        p_restaurant_id: restaurantId,
        p_user_id: userId,
        p_resend: resend,
        p_expected_role: expectedRole,
      });
      if (error) throw new Error("claim failed");
      if (data === null) return { invitationSent, deliveryPending: false };
      const lease = leaseSchema.parse(data);
      if (lease.userId !== userId) throw new Error("unexpected invitation identity");
      try {
        const result = await this.admin.auth.admin.inviteUserByEmail(lease.email, { redirectTo });
        invitationSent = !result.error && result.data.user?.id === userId;
      } catch {
        // Transport failures can be retried when the delivery lease expires.
      }
      const finished = await this.admin.rpc("finish_restaurant_invitation", {
        p_lease_id: lease.leaseId,
        p_success: invitationSent,
      });
      if (finished.error) throw new Error("finish failed");
    } catch {
      // Business data is already committed. The durable request can be retried.
      return { invitationSent, deliveryPending: !invitationSent };
    }
    return { invitationSent, deliveryPending: !invitationSent };
  }
}
