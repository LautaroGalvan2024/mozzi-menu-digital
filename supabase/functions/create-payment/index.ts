import { getRateLimitSecret, getSupabaseUrl } from "../_shared/config.ts";
import { hmacSha256Hex, randomToken, sha256Hex } from "../_shared/crypto.ts";
import { z } from "../_shared/deps.ts";
import { ApiError } from "../_shared/errors.ts";
import { readJson, safeLog, serve } from "../_shared/http.ts";
import { assertCheckoutUrl } from "../_shared/mercadopago-core.ts";
import {
  beginPaymentCheckout,
  createAdminClient,
  paymentReturnUrl,
  providerLiveMode,
  providerRequest,
  rpc,
} from "../_shared/mercadopago.ts";
import { assertOrderRateLimitAllowed } from "../_shared/rate-limit.ts";
import { clientIp } from "../_shared/request-meta.ts";
import { createOrderSchema, parseInput } from "../_shared/schemas.ts";
import { verifyTurnstileIfEnabled } from "../_shared/turnstile.ts";

const beginSchema = z.object({
  orderId: z.string().uuid(),
  actionId: z.string().uuid(),
  restaurantId: z.string().uuid(),
  accountId: z.string().uuid(),
  liveMode: z.boolean(),
  attemptId: z.string().uuid(),
  totalCents: z.coerce.number().int().positive(),
  currencyCode: z.literal("ARS"),
  expiresAt: z.string(),
  recoveryExpiresAt: z.string(),
  checkoutUrl: z.string().nullable(),
  providerPreferenceId: z.string().nullable(),
  preferenceLeaseAcquired: z.boolean(),
  preferenceLeaseId: z.string().uuid().nullable(),
});

serve({
  maxBodyBytes: 192 * 1024,
  handler: async (request, context) => {
    const input = parseInput(createOrderSchema, await readJson(request, 192 * 1024));
    if (input.channel !== "store" || input.checkoutMode !== "online") {
      throw new ApiError(422, "CHECKOUT_MODE_INVALID", "Elegí el pago online de la tienda.");
    }
    const age = Date.now() - Date.parse(input.antiSpam.formStartedAt);
    if (
      input.antiSpam.honeypot?.trim() || !Number.isFinite(age) || age < 1000 || age > 7_200_000
    ) {
      throw new ApiError(422, "STALE_FORM", "Actualizá el formulario y volvé a intentar.");
    }
    await verifyTurnstileIfEnabled(input.antiSpam.turnstileToken);
    const [ipHash, phoneHash] = await Promise.all([
      hmacSha256Hex(getRateLimitSecret(), `ip:${clientIp(request)}`),
      hmacSha256Hex(getRateLimitSecret(), `phone:${input.customer.phone}`),
    ]);
    const admin = createAdminClient();
    assertOrderRateLimitAllowed(
      await rpc(admin, "check_order_rate_limits", {
        p_restaurant_slug: input.restaurantSlug,
        p_ip_hash: ipHash,
        p_phone_hash: phoneHash,
      }),
    );
    const recoveryToken = randomToken(32);
    const statusHash = await sha256Hex(recoveryToken);
    const { antiSpam: _antiSpam, ...business } = input;
    const checkout = await beginPaymentCheckout(admin, {
      request: business,
      ipHash,
      phoneHash,
      clientEventTokenHash: await sha256Hex(randomToken(32)),
      statusTokenHash: statusHash,
    });
    const attempt = beginSchema.parse(checkout.attempt);
    const account = checkout.account;
    if (!attempt.checkoutUrl && Date.parse(attempt.expiresAt) > Date.now()) {
      if (!attempt.preferenceLeaseAcquired || !attempt.preferenceLeaseId) {
        throw new ApiError(
          503,
          "PAYMENT_PREPARING",
          "Estamos preparando este pago. Esperá unos segundos y reintentá la misma compra.",
        );
      }
      const returnUrl = paymentReturnUrl(input.restaurantSlug, attempt.actionId);
      const preference = z.object({
        id: z.string(),
        init_point: z.string(),
        sandbox_init_point: z.string().optional(),
        collector_id: z.union([z.string(), z.number()]).transform(String),
      }).parse(
        await providerRequest("/checkout/preferences", account.accessToken, {
          external_reference: attempt.attemptId,
          items: [{
            id: attempt.orderId,
            title: "Compra en tienda",
            quantity: 1,
            currency_id: attempt.currencyCode,
            unit_price: attempt.totalCents / 100,
          }],
          back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl },
          auto_return: "approved",
          notification_url: `${getSupabaseUrl()}/functions/v1/mercadopago-webhook`,
          expires: true,
          expiration_date_from: new Date().toISOString(),
          expiration_date_to: attempt.expiresAt,
          payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] },
          marketplace_fee: 0,
        }),
      );
      if (preference.collector_id !== account.providerUserId) {
        throw new Error("Preference merchant mismatch");
      }
      const checkoutUrl = assertCheckoutUrl(
        !attempt.liveMode
          ? preference.sandbox_init_point ?? preference.init_point
          : preference.init_point,
      );
      await rpc(admin, "set_online_checkout_preference", {
        p_attempt_id: attempt.attemptId,
        p_preference_id: preference.id,
        p_checkout_url: checkoutUrl,
        p_lease_id: attempt.preferenceLeaseId,
      });
    }
    const summary = z.record(z.string(), z.unknown()).parse(
      await rpc(admin, "get_online_checkout_status", {
        p_action_id: attempt.actionId,
        p_token_hash: statusHash,
        p_live_mode: providerLiveMode(),
      }),
    );
    safeLog("info", "payment.checkout_created", context.requestId, { actionId: attempt.actionId });
    return { ...summary, recoveryToken, recoveryExpiresAt: attempt.recoveryExpiresAt };
  },
});
