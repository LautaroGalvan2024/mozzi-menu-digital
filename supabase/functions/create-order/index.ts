import { getAppBaseUrl } from "../_shared/config.ts";
import { randomToken, sha256Hex } from "../_shared/crypto.ts";
import { databaseApiError } from "../_shared/errors.ts";
import { jsonResponse, safeLog, serve } from "../_shared/http.ts";
import { orderConfirmationResponse } from "../_shared/order-confirmation.ts";
import { prepareOrder } from "../_shared/prepare-order.ts";

const MAX_BODY_BYTES = 192 * 1_024;
const CLIENT_EVENT_LIFETIME_MS = 30 * 60 * 1_000;

serve({
  name: "create-order",
  maxBodyBytes: MAX_BODY_BYTES,
  handler: async (request, context) => {
    const { admin, business, ipHash, phoneHash } = await prepareOrder(
      await context.readJson(),
      request,
      "whatsapp",
    );

    const clientEventToken = randomToken(32);
    const clientEventTokenHash = await sha256Hex(clientEventToken);
    const tokenExpiresAt = new Date(Date.now() + CLIENT_EVENT_LIFETIME_MS).toISOString();
    const recoveryToken = randomToken(32);
    const recoveryTokenHash = await sha256Hex(recoveryToken);
    const recoveryExpiresAt = new Date(Date.now() + CLIENT_EVENT_LIFETIME_MS).toISOString();

    // This public function has a deliberately narrow service-only creation RPC. Prices,
    // availability, opening hours, snapshots, idempotency and inserts are checked atomically.
    const { data, error } = await admin.rpc("create_order_transaction", {
      p_request: { ...business, tokenExpiresAt, recoveryTokenHash, recoveryExpiresAt },
      p_ip_hash: ipHash,
      p_phone_hash: phoneHash,
      p_client_event_token_hash: clientEventTokenHash,
    });
    if (error) throw databaseApiError(error);

    const result = orderConfirmationResponse(data, getAppBaseUrl(), {
      clientEventToken,
      clientEventExpiresAtFallback: tokenExpiresAt,
      recoveryToken,
    });
    safeLog("info", "order.created", context.requestId, {
      actionId: result.order.actionId,
      displayNumber: result.order.displayNumber,
      idempotentReplay: result.idempotentReplay,
    });

    return jsonResponse(result, result.idempotentReplay ? 200 : 201);
  },
});
