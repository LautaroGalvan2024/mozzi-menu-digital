import { createAdminClient } from "../_shared/clients.ts";
import { getAppBaseUrl, getRateLimitSecret } from "../_shared/config.ts";
import { hmacSha256Hex, sha256Hex } from "../_shared/crypto.ts";
import { databaseApiError } from "../_shared/errors.ts";
import { readJson, serve } from "../_shared/http.ts";
import {
  orderConfirmationResponse,
  parseRecoveryRequest,
  recoveryUnavailable,
} from "../_shared/order-confirmation.ts";
import { assertOrderRateLimitAllowed } from "../_shared/rate-limit.ts";
import { clientIp } from "../_shared/request-meta.ts";

const MAX_BODY_BYTES = 4 * 1_024;

serve({
  maxBodyBytes: MAX_BODY_BYTES,
  handler: async (request) => {
    const input = parseRecoveryRequest(await readJson(request, MAX_BODY_BYTES));
    const admin = createAdminClient();
    const ipHash = await hmacSha256Hex(
      getRateLimitSecret(),
      `order-recovery-ip:${clientIp(request)}`,
    );
    // A separate committed transaction counts unsuccessful token guesses as well.
    const limit = await admin.rpc("check_order_recovery_rate_limit", { p_ip_hash: ipHash });
    if (limit.error) throw databaseApiError(limit.error);
    assertOrderRateLimitAllowed(limit.data);
    const recovery = await admin.rpc("recover_order_confirmation", {
      p_action_id: input.actionId,
      p_recovery_token_hash: await sha256Hex(input.recoveryToken),
    });
    if (recovery.error) throw databaseApiError(recovery.error);
    if (recovery.data === null) throw recoveryUnavailable();
    // Lookup is read-only: no telemetry token, state transition or TTL renewal.
    // Do not log the bearer token, request payload or recovered customer details.
    return orderConfirmationResponse(recovery.data, getAppBaseUrl(), {
      clientEventToken: null,
      recoveryToken: input.recoveryToken,
    });
  },
});
