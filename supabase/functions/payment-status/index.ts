import { getRateLimitSecret } from "../_shared/config.ts";
import { hmacSha256Hex, sha256Hex } from "../_shared/crypto.ts";
import { z } from "../_shared/deps.ts";
import { ApiError } from "../_shared/errors.ts";
import { readJson, serve } from "../_shared/http.ts";
import { createAdminClient, providerLiveMode, rpc } from "../_shared/mercadopago.ts";
import { assertOrderRateLimitAllowed } from "../_shared/rate-limit.ts";
import { clientIp } from "../_shared/request-meta.ts";
import { parseInput } from "../_shared/schemas.ts";

serve({
  maxBodyBytes: 2048,
  handler: async (request) => {
    const input = parseInput(
      z.object({
        actionId: z.string().uuid(),
        recoveryToken: z.string().min(40).max(100).regex(/^[A-Za-z0-9_-]+$/),
      }).strict(),
      await readJson(request, 2048),
    );
    const admin = createAdminClient();
    assertOrderRateLimitAllowed(
      await rpc(admin, "check_order_recovery_rate_limit", {
        p_ip_hash: await hmacSha256Hex(
          getRateLimitSecret(),
          `payment-status-ip:${clientIp(request)}`,
        ),
      }),
    );
    const summary = await rpc(admin, "get_online_checkout_status", {
      p_action_id: input.actionId,
      p_token_hash: await sha256Hex(input.recoveryToken),
      p_live_mode: providerLiveMode(),
    });
    if (!summary) {
      throw new ApiError(
        404,
        "PAYMENT_STATUS_UNAVAILABLE",
        "El enlace de esta compra venció o no está disponible.",
      );
    }
    return summary;
  },
});
