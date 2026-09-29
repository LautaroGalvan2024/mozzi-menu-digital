import { createAdminClient } from "../_shared/clients.ts";
import { getAppBaseUrl, getRateLimitSecret } from "../_shared/config.ts";
import { hmacSha256Hex, randomToken, sha256Hex } from "../_shared/crypto.ts";
import { ApiError, databaseApiError } from "../_shared/errors.ts";
import { jsonResponse, readJson, safeLog, serve } from "../_shared/http.ts";
import { parseOrderResult, parseOrderRpcMetadata } from "../_shared/order-result.ts";
import { assertOrderRateLimitAllowed } from "../_shared/rate-limit.ts";
import { clientIp } from "../_shared/request-meta.ts";
import { createOrderSchema, parseInput } from "../_shared/schemas.ts";
import { verifyTurnstileIfEnabled } from "../_shared/turnstile.ts";
import { buildWhatsapp } from "../_shared/whatsapp.ts";

const MAX_BODY_BYTES = 192 * 1_024;
const MIN_FORM_AGE_MS = 1_000;
const MAX_FORM_AGE_MS = 2 * 60 * 60 * 1_000;
const CLIENT_EVENT_LIFETIME_MS = 30 * 60 * 1_000;

serve({
  maxBodyBytes: MAX_BODY_BYTES,
  handler: async (request, context) => {
    const input = parseInput(createOrderSchema, await readJson(request, MAX_BODY_BYTES));
    if (input.antiSpam.honeypot?.trim()) {
      throw new ApiError(400, "REQUEST_REJECTED", "No se pudo procesar la solicitud.");
    }
    const formAge = Date.now() - Date.parse(input.antiSpam.formStartedAt);
    if (!Number.isFinite(formAge) || formAge < MIN_FORM_AGE_MS || formAge > MAX_FORM_AGE_MS) {
      throw new ApiError(422, "STALE_FORM", "Actualizá el formulario y volvé a intentar.");
    }
    await verifyTurnstileIfEnabled(input.antiSpam.turnstileToken);

    const rateSecret = getRateLimitSecret();
    const [ipHash, phoneHash] = await Promise.all([
      hmacSha256Hex(rateSecret, `ip:${clientIp(request)}`),
      hmacSha256Hex(rateSecret, `phone:${input.customer.phone}`),
    ]);

    // This is intentionally a separate PostgREST transaction. Its counters commit even when
    // the later catalogue, opening-hours or checkout validation rejects the order.
    const admin = createAdminClient();
    const { data: rateLimitData, error: rateLimitError } = await admin.rpc(
      "check_order_rate_limits",
      {
        p_restaurant_slug: input.restaurantSlug,
        p_ip_hash: ipHash,
        p_phone_hash: phoneHash,
      },
    );
    if (rateLimitError) throw databaseApiError(rateLimitError);
    assertOrderRateLimitAllowed(rateLimitData);

    const clientEventToken = randomToken(32);
    const clientEventTokenHash = await sha256Hex(clientEventToken);
    const tokenExpiresAt = new Date(Date.now() + CLIENT_EVENT_LIFETIME_MS).toISOString();
    const { antiSpam: _antiSpam, ...orderRequest } = input;

    // This public function has a deliberately narrow service-only creation RPC. Prices,
    // availability, opening hours, snapshots, idempotency and inserts are checked atomically.
    const { data, error } = await admin.rpc("create_order_transaction", {
      p_request: { ...orderRequest, tokenExpiresAt },
      p_ip_hash: ipHash,
      p_phone_hash: phoneHash,
      p_client_event_token_hash: clientEventTokenHash,
    });
    if (error) throw databaseApiError(error);

    const metadata = parseOrderRpcMetadata(data);
    const result = parseOrderResult(data);
    const whatsapp = buildWhatsapp(result.canonical, getAppBaseUrl());
    safeLog("info", "order.created", context.requestId, {
      actionId: result.canonical.actionId,
      displayNumber: result.canonical.displayNumber,
      idempotentReplay: result.idempotentReplay,
    });

    return jsonResponse({
      order: {
        actionId: result.canonical.actionId,
        displayNumber: result.canonical.displayNumber,
        status: result.status,
        totalCents: result.canonical.totalCents,
        currencyCode: result.canonical.currencyCode,
        createdAt: result.canonical.createdAt,
      },
      whatsapp,
      clientEventToken: metadata.clientEventTokenStored ? clientEventToken : null,
      clientEventExpiresAt: metadata.clientEventExpiresAt ?? tokenExpiresAt,
      idempotentReplay: result.idempotentReplay,
    }, result.idempotentReplay ? 200 : 201);
  },
});
