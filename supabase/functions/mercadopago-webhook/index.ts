import { requireEnv } from "../_shared/config.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, toApiError } from "../_shared/errors.ts";
import { jsonResponse, readJson, safeLog } from "../_shared/http.ts";
import { verifyPaymentSignature } from "../_shared/mercadopago-core.ts";
import {
  createAdminClient,
  paymentAccount,
  providerRequest,
  reconcileProviderPayment,
} from "../_shared/mercadopago.ts";

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  try {
    if (request.method !== "POST") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
    }
    const dataId = new URL(request.url).searchParams.get("data.id") ?? "";
    await verifyPaymentSignature(request, dataId, requireEnv("MERCADOPAGO_WEBHOOK_SECRET"));
    const event = z.object({
      type: z.string(),
      data: z.object({ id: z.union([z.string(), z.number()]).transform(String) }),
      user_id: z.union([z.string(), z.number()]).transform(String),
    }).parse(await readJson(request, 16 * 1024));
    if (event.data.id.toLowerCase() !== dataId.toLowerCase()) {
      throw new ApiError(400, "INVALID_EVENT", "Notificación inválida.");
    }
    if (event.type !== "payment") return jsonResponse({ received: true });
    const admin = createAdminClient();
    const account = await paymentAccount(admin, { providerUserId: event.user_id });
    // Only provider-fetched fields can authorize fulfillment, never webhook body fields.
    const payment = await providerRequest(
      `/v1/payments/${encodeURIComponent(dataId)}`,
      account.accessToken,
    );
    await reconcileProviderPayment(admin, payment, account);
    safeLog("info", "payment.reconciled", requestId, { restaurantId: account.restaurantId });
    return jsonResponse({ received: true });
  } catch (error) {
    const failure = toApiError(error);
    safeLog("error", "payment.webhook_failed", requestId, { code: failure.code });
    return jsonResponse(
      { error: { code: failure.code, message: failure.message }, requestId },
      failure.status,
    );
  }
});
