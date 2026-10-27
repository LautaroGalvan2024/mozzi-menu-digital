import { z } from "../_shared/deps.ts";
import { readJson, serve } from "../_shared/http.ts";
import {
  authorizePaymentAdmin,
  beginPaymentConnection,
  createAdminClient,
  paymentConnectionStatus,
  rpc,
} from "../_shared/mercadopago.ts";
import { parseInput } from "../_shared/schemas.ts";

serve({
  maxBodyBytes: 2048,
  handler: async (request) => {
    const input = parseInput(
      z.object({
        restaurantId: z.string().uuid(),
        action: z.enum(["connect", "disconnect", "status"]).default("status"),
      }).strict(),
      await readJson(request, 2048),
    );
    const actor = await authorizePaymentAdmin(request, input.restaurantId);
    const admin = createAdminClient();
    if (input.action === "status") {
      return await paymentConnectionStatus(admin, input.restaurantId);
    }
    if (input.action === "disconnect") {
      await rpc(admin, "disconnect_payment_account", { p_restaurant_id: input.restaurantId });
      return { disconnected: true };
    }
    return await beginPaymentConnection(admin, {
      restaurantId: input.restaurantId,
      actorId: actor.user.id,
      superAdminAal2: actor.authorization.isSuperAdmin,
    });
  },
});
