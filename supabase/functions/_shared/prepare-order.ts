import { createAdminClient } from "./clients.ts";
import { getRateLimitSecret } from "./config.ts";
import { hmacSha256Hex } from "./crypto.ts";
import { ApiError, databaseApiError } from "./errors.ts";
import { assertOrderRateLimitAllowed } from "./rate-limit.ts";
import { clientIp } from "./request-meta.ts";
import { createOrderSchema, parseInput } from "./schemas.ts";
import { verifyTurnstileIfEnabled } from "./turnstile.ts";

export async function prepareOrder(
  payload: unknown,
  request: Request,
  mode: "online" | "whatsapp",
) {
  const { antiSpam, ...business } = parseInput(createOrderSchema, payload);
  if (mode === "online" && (business.channel !== "store" || business.checkoutMode !== "online")) {
    throw new ApiError(422, "CHECKOUT_MODE_INVALID", "Elegí el pago online de la tienda.");
  }
  if (mode === "whatsapp" && business.checkoutMode === "online") {
    throw new ApiError(422, "CHECKOUT_MODE_INVALID", "Usá el pago online de la tienda.");
  }
  const honeypot = Boolean(antiSpam.honeypot?.trim());
  if (mode === "whatsapp" && honeypot) {
    throw new ApiError(400, "REQUEST_REJECTED", "No se pudo procesar la solicitud.");
  }
  const age = Date.now() - Date.parse(antiSpam.formStartedAt);
  if (honeypot || !Number.isFinite(age) || age < 1_000 || age > 7_200_000) {
    throw new ApiError(422, "STALE_FORM", "Actualizá el formulario y volvé a intentar.");
  }
  await verifyTurnstileIfEnabled(antiSpam.turnstileToken);

  const secret = getRateLimitSecret();
  const [ipHash, phoneHash] = await Promise.all([
    hmacSha256Hex(secret, `ip:${clientIp(request)}`),
    hmacSha256Hex(secret, `phone:${business.customer.phone}`),
  ]);
  const admin = createAdminClient();
  // The rate limit commits even if the later order transaction is rejected.
  const { data, error } = await admin.rpc("check_order_rate_limits", {
    p_restaurant_slug: business.restaurantSlug,
    p_ip_hash: ipHash,
    p_phone_hash: phoneHash,
  });
  if (error) throw databaseApiError(error);
  assertOrderRateLimitAllowed(data);
  return { admin, business, ipHash, phoneHash };
}
