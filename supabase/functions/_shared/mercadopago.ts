import { activeRestaurantRole, requireAal2, verifyActor } from "./auth.ts";
import { createAdminClient } from "./clients.ts";
import { getAppBaseUrl, getSupabaseUrl, requireEnv } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { type SupabaseClient, z } from "./deps.ts";
import { ApiError, databaseApiError } from "./errors.ts";
import {
  decryptCredentials,
  encryptCredentials,
  paymentAmountCents,
  pkceChallenge,
} from "./mercadopago-core.ts";
import { invalidTokenResponse, oauthProviderFailure } from "./mercadopago-errors.ts";

// OAuth client_id is the application's numeric APP_ID, not its Public Key or Access Token.
// Keep it as a string; the upper bound is defensive, not an assumed provider ID length.
const CLIENT_ID_PATTERN = /^[1-9][0-9]{0,31}$/;

export function paymentConnectionConfiguration(): {
  configured: boolean;
  configurationIssue: "invalid_client_id" | "missing_configuration" | null;
} {
  const clientId = Deno.env.get("MERCADOPAGO_CLIENT_ID")?.trim();
  if (clientId && !CLIENT_ID_PATTERN.test(clientId)) {
    return { configured: false, configurationIssue: "invalid_client_id" };
  }
  const complete = clientId && [
    "MERCADOPAGO_CLIENT_SECRET",
    "MERCADOPAGO_ENCRYPTION_KEY",
    "MERCADOPAGO_WEBHOOK_SECRET",
  ].every((name) => Boolean(Deno.env.get(name)?.trim()));
  return complete
    ? { configured: true, configurationIssue: null }
    : { configured: false, configurationIssue: "missing_configuration" };
}

export function requireMercadoPagoClientId(): string {
  const clientId = Deno.env.get("MERCADOPAGO_CLIENT_ID")?.trim();
  if (!clientId || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new ApiError(
      500,
      "PAYMENT_CONFIGURATION_ERROR",
      "La plataforma debe configurar el Client ID numérico de la aplicación de Mercado Pago.",
    );
  }
  return clientId;
}

export const providerTokenSchema = z.object({
  access_token: z.string().min(8),
  refresh_token: z.string().min(8),
  user_id: z.union([z.string(), z.number()]).transform(String),
  expires_in: z.number().positive(),
  live_mode: z.boolean(),
});
export function validateProviderToken(raw: unknown): z.infer<typeof providerTokenSchema> {
  const result = providerTokenSchema.safeParse(raw);
  if (!result.success) {
    throw invalidTokenResponse(
      raw,
      result.error.issues.flatMap((issue) => issue.path.length ? [issue.path[0]!] : []),
    );
  }
  return result.data;
}
const accountSchema = z.object({
  restaurantId: z.string().uuid(),
  providerUserId: z.string(),
  encryptedCredentials: z.string(),
  expiresAt: z.string(),
  active: z.boolean(),
});
const credentialsSchema = z.object({
  accessToken: z.string().min(8),
  refreshToken: z.string().min(8),
});
export const paymentAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  orderId: z.string().uuid(),
  restaurantId: z.string().uuid(),
  providerPreferenceId: z.string().nullable(),
  providerPaymentId: z.string().nullable(),
  totalCents: z.coerce.number().int().positive(),
  currencyCode: z.literal("ARS"),
  expiresAt: z.string(),
  paymentStatus: z.string(),
});
export const providerPaymentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  collector_id: z.union([z.string(), z.number()]).transform(String),
  external_reference: z.string(),
  transaction_amount: z.number(),
  currency_id: z.string(),
  status: z.string(),
  date_last_updated: z.string().datetime({ offset: true }),
  transaction_amount_refunded: z.number().optional(),
  live_mode: z.boolean(),
});

export async function rpc(
  admin: SupabaseClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw databaseApiError(error);
  return data;
}

export function mpEncryptionKey(): string {
  return requireEnv("MERCADOPAGO_ENCRYPTION_KEY");
}
export function oauthRedirectUri(): string {
  return `${getSupabaseUrl()}/functions/v1/mercadopago-callback`;
}
function providerLiveMode(): boolean {
  return Deno.env.get("MERCADOPAGO_MODE") !== "test";
}
export async function exchangeAuthorizationCode(code: string, verifier: string): Promise<unknown> {
  return await providerRequest("/oauth/token", undefined, {
    grant_type: "authorization_code",
    client_id: requireMercadoPagoClientId(),
    client_secret: requireEnv("MERCADOPAGO_CLIENT_SECRET"),
    code,
    redirect_uri: oauthRedirectUri(),
    code_verifier: verifier,
    ...(!providerLiveMode() ? { test_token: true } : {}),
  });
}

/** Call only after authorizing the administrator; deployment errors never create OAuth state. */
export async function beginPaymentConnection(
  admin: SupabaseClient,
  actor: { restaurantId: string; actorId: string; superAdminAal2: boolean },
): Promise<{ authorizationUrl: string }> {
  const clientId = requireMercadoPagoClientId();
  requireEnv("MERCADOPAGO_CLIENT_SECRET");
  requireEnv("MERCADOPAGO_WEBHOOK_SECRET");
  getAppBaseUrl();
  const redirectUri = oauthRedirectUri();
  const encryptionKey = mpEncryptionKey();
  const state = randomToken(32);
  const verifier = randomToken(48);
  const stateHash = await sha256Hex(state);
  const encryptedPayload = await encryptCredentials(
    { ...actor, verifier },
    encryptionKey,
    stateHash,
  );
  const url = new URL("https://auth.mercadopago.com/authorization");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    platform_id: "mp",
    state,
    redirect_uri: redirectUri,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  await rpc(admin, "save_payment_oauth_state", {
    p_state_hash: stateHash,
    p_encrypted_payload: encryptedPayload,
  });
  return { authorizationUrl: url.href };
}
export function paymentReturnUrl(slug: string, actionId: string): string {
  return `${getAppBaseUrl()}/t/${encodeURIComponent(slug)}/pago?order=${
    encodeURIComponent(actionId)
  }`;
}

export async function authorizePaymentAdmin(request: Request, restaurantId: string) {
  const actor = await verifyActor(request);
  if (actor.authorization.isSuperAdmin) await requireAal2(actor);
  else if (activeRestaurantRole(actor, restaurantId) !== "restaurant_admin") {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Solo un administrador del comercio puede configurar los cobros.",
    );
  }
  return actor;
}

export async function providerRequest(
  path: string,
  accessToken?: string,
  body?: unknown,
  method = body ? "POST" : "GET",
): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid provider path");
  let response: Response;
  try {
    response = await fetch(`https://api.mercadopago.com${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new ApiError(
      503,
      "PAYMENT_PROVIDER_UNAVAILABLE",
      "No pudimos contactar a Mercado Pago. Reintentá esta misma compra.",
    );
  }
  if (!response.ok) {
    if (path === "/oauth/token") throw await oauthProviderFailure(response);
    await response.body?.cancel();
    throw new ApiError(
      response.status >= 500 ? 503 : 409,
      "PAYMENT_PROVIDER_ERROR",
      "Mercado Pago no pudo completar la operación. Revisá la conexión del comercio o reintentá.",
    );
  }
  try {
    return await response.json();
  } catch (error) {
    if (path === "/oauth/token") throw invalidTokenResponse(undefined, []);
    throw error;
  }
}

export async function saveProviderAccount(
  admin: SupabaseClient,
  restaurantId: string,
  raw: unknown,
  activate = true,
): Promise<void> {
  const token = validateProviderToken(raw);
  if (token.live_mode !== providerLiveMode()) {
    throw new ApiError(
      409,
      "PAYMENT_ENVIRONMENT_MISMATCH",
      "La cuenta de Mercado Pago no corresponde al ambiente de cobros configurado.",
    );
  }
  await rpc(admin, "save_payment_account", {
    p_restaurant_id: restaurantId,
    p_provider_user_id: token.user_id,
    p_encrypted_credentials: await encryptCredentials(
      { accessToken: token.access_token, refreshToken: token.refresh_token },
      mpEncryptionKey(),
      restaurantId,
    ),
    p_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    p_activate: activate,
  });
}

export async function paymentAccount(
  admin: SupabaseClient,
  lookup: { restaurantId: string } | { providerUserId: string },
  requireActive = false,
) {
  const raw = await rpc(
    admin,
    "get_payment_account",
    "restaurantId" in lookup
      ? { p_restaurant_id: lookup.restaurantId }
      : { p_provider_user_id: lookup.providerUserId },
  );
  if (!raw) {
    throw new ApiError(409, "PAYMENT_NOT_CONNECTED", "El comercio debe conectar Mercado Pago.");
  }
  const account = accountSchema.parse(raw);
  if (requireActive && !account.active) {
    throw new ApiError(409, "PAYMENT_NOT_CONNECTED", "El comercio debe conectar Mercado Pago.");
  }
  let credentials = credentialsSchema.parse(
    await decryptCredentials(account.encryptedCredentials, mpEncryptionKey(), account.restaurantId),
  );
  if (Date.parse(account.expiresAt) <= Date.now() + 60_000) {
    const clientId = requireMercadoPagoClientId();
    const acquired = await rpc(admin, "acquire_payment_account_refresh", {
      p_restaurant_id: account.restaurantId,
      p_expected_expires_at: account.expiresAt,
    });
    if (acquired !== true) {
      throw new ApiError(
        503,
        "PAYMENT_PREPARING",
        "Se está renovando la conexión de pago. Reintentá en unos segundos.",
      );
    }
    // Refresh inherits the original token's environment; test_token belongs to initial authorization.
    // https://www.mercadopago.com.ar/developers/es/docs/split-payments/additional-content/security/oauth/renewal
    const refresh = validateProviderToken(
      await providerRequest("/oauth/token", undefined, {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: requireEnv("MERCADOPAGO_CLIENT_SECRET"),
        refresh_token: credentials.refreshToken,
      }),
    );
    if (refresh.user_id !== account.providerUserId) {
      throw new Error("Provider refresh account mismatch");
    }
    await saveProviderAccount(admin, account.restaurantId, refresh, false);
    credentials = { accessToken: refresh.access_token, refreshToken: refresh.refresh_token };
  }
  return { ...account, accessToken: credentials.accessToken };
}

export async function reconcileProviderPayment(
  admin: SupabaseClient,
  raw: unknown,
  account: { restaurantId: string; providerUserId: string },
) {
  const payment = providerPaymentSchema.parse(raw);
  if (
    payment.collector_id !== account.providerUserId ||
    payment.live_mode !== providerLiveMode()
  ) throw new Error("Provider account/environment mismatch");
  if (!z.string().uuid().safeParse(payment.external_reference).success) return null; // A different integration's payment.
  const rawAttempt = await rpc(admin, "get_online_payment_attempt", {
    p_attempt_id: payment.external_reference,
  });
  if (!rawAttempt) return null;
  const attempt = paymentAttemptSchema.parse(rawAttempt);
  if (
    attempt.restaurantId !== account.restaurantId ||
    attempt.totalCents !== paymentAmountCents(payment.transaction_amount) ||
    attempt.currencyCode !== payment.currency_id
  ) {
    throw new Error("Payment does not match canonical order");
  }
  const statuses: Record<string, string> = {
    approved: "approved",
    pending: "pending",
    in_process: "pending",
    authorized: "pending",
    rejected: "rejected",
    cancelled: "cancelled",
    refunded: "refunded",
    charged_back: "charged_back",
    in_mediation: "in_mediation",
  };
  let status = statuses[payment.status];
  if (!status) throw new Error("Unsupported provider payment state");
  if (payment.status === "approved" && (payment.transaction_amount_refunded ?? 0) > 0) {
    status = "partially_refunded";
  }
  return await rpc(admin, "reconcile_online_payment", {
    p_attempt_id: attempt.attemptId,
    p_payment_id: payment.id,
    p_status: status,
    p_amount_cents: attempt.totalCents,
    p_currency: attempt.currencyCode,
    p_provider_updated_at: payment.date_last_updated,
    p_provider_data: {
      refundedCents: paymentAmountCents(payment.transaction_amount_refunded ?? 0),
    },
  });
}

export async function reconcileAttempt(
  admin: SupabaseClient,
  attempt: z.infer<typeof paymentAttemptSchema>,
): Promise<void> {
  const account = await paymentAccount(admin, { restaurantId: attempt.restaurantId });
  const search = z.object({
    results: z.array(providerPaymentSchema),
    paging: z.object({ total: z.number() }).optional(),
  }).parse(
    await providerRequest(
      `/v1/payments/search?external_reference=${
        encodeURIComponent(attempt.attemptId)
      }&sort=date_created&criteria=desc&limit=100`,
      account.accessToken,
    ),
  );
  if ((search.paging?.total ?? search.results.length) > 100) {
    throw new Error("Payment reconciliation requires pagination");
  }
  // Oldest first ensures later financial events are applied after earlier attempts.
  for (
    const payment of [...search.results].sort((a, b) =>
      a.date_last_updated.localeCompare(b.date_last_updated)
    )
  ) await reconcileProviderPayment(admin, payment, account);
  await rpc(admin, "mark_online_reconciled", { p_attempt_id: attempt.attemptId });
}

export { createAdminClient };
