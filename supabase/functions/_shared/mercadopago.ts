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
function assertPaymentEnvironment(actualLiveMode: boolean, expectedLiveMode: boolean): void {
  if (actualLiveMode !== expectedLiveMode) {
    throw new ApiError(
      409,
      "PAYMENT_ENVIRONMENT_MISMATCH",
      "La cuenta de Mercado Pago no corresponde al ambiente de cobros configurado.",
    );
  }
}

/** Only OAuth responses may omit live_mode; the caller must supply the known request/account mode. */
export function normalizeOAuthTokenResponse(
  raw: unknown,
  expectedLiveMode: boolean,
): z.infer<typeof providerTokenSchema> {
  if (typeof expectedLiveMode !== "boolean") {
    throw new ApiError(
      500,
      "PAYMENT_CONFIGURATION_ERROR",
      "No se pudo verificar el ambiente de la conexión de Mercado Pago.",
    );
  }
  const mayAddMode = raw && typeof raw === "object" && !Array.isArray(raw) &&
    !Object.hasOwn(raw, "live_mode");
  const token = validateProviderToken(mayAddMode ? { ...raw, live_mode: expectedLiveMode } : raw);
  assertPaymentEnvironment(token.live_mode, expectedLiveMode);
  return token;
}
const accountSchema = z.object({
  accountId: z.string().uuid(),
  restaurantId: z.string().uuid(),
  providerUserId: z.string(),
  encryptedCredentials: z.string(),
  expiresAt: z.string(),
  active: z.boolean(),
  isCurrent: z.boolean(),
  liveMode: z.boolean().nullable(),
});
const credentialsSchema = z.object({
  accessToken: z.string().min(8),
  refreshToken: z.string().min(8),
  liveMode: z.boolean(),
});
export const paymentAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  orderId: z.string().uuid(),
  restaurantId: z.string().uuid(),
  accountId: z.string().uuid(),
  liveMode: z.boolean(),
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
export function providerLiveMode(): boolean {
  return Deno.env.get("MERCADOPAGO_MODE") !== "test";
}
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  requestedLiveMode = providerLiveMode(),
): Promise<{ rawToken: unknown; requestedLiveMode: boolean }> {
  // The browser's OAuth round trip must finish in the environment it authorized.
  assertPaymentEnvironment(requestedLiveMode, providerLiveMode());
  const rawToken = await providerRequest("/oauth/token", undefined, {
    grant_type: "authorization_code",
    client_id: requireMercadoPagoClientId(),
    client_secret: requireEnv("MERCADOPAGO_CLIENT_SECRET"),
    code,
    redirect_uri: oauthRedirectUri(),
    code_verifier: verifier,
    ...(!requestedLiveMode ? { test_token: true } : {}),
  });
  return { rawToken, requestedLiveMode };
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
    { ...actor, verifier, liveMode: providerLiveMode() },
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
): Promise<void> {
  const token = validateProviderToken(raw);
  assertPaymentEnvironment(token.live_mode, providerLiveMode());
  await rpc(admin, "save_payment_account", {
    p_restaurant_id: restaurantId,
    p_provider_user_id: token.user_id,
    p_encrypted_credentials: await encryptCredentials(
      {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        liveMode: token.live_mode,
      },
      mpEncryptionKey(),
      restaurantId,
    ),
    p_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    p_live_mode: token.live_mode,
  });
}

type AccountLookup = { restaurantId: string } | { accountId: string } | {
  providerUserId: string;
  liveMode?: boolean;
};

function accountLookupArguments(lookup: AccountLookup): Record<string, unknown> {
  if ("accountId" in lookup) return { p_account_id: lookup.accountId };
  if ("restaurantId" in lookup) return { p_restaurant_id: lookup.restaurantId };
  return {
    p_provider_user_id: lookup.providerUserId,
    ...(lookup.liveMode === undefined ? {} : { p_live_mode: lookup.liveMode }),
  };
}

async function accountCredentials(account: z.infer<typeof accountSchema>) {
  const parsed = credentialsSchema.safeParse(
    await decryptCredentials(account.encryptedCredentials, mpEncryptionKey(), account.restaurantId),
  );
  if (!parsed.success || account.liveMode === null) {
    throw new ApiError(
      409,
      "PAYMENT_ACCOUNT_RECONNECT_REQUIRED",
      "La conexión guardada de Mercado Pago necesita renovarse. Reconectá la cuenta desde el panel del comercio.",
    );
  }
  // Both metadata used to route payments and authenticated encrypted credentials must agree.
  assertPaymentEnvironment(parsed.data.liveMode, account.liveMode);
  return parsed.data;
}

/** Read only after authorization; never return encrypted credentials or contact the provider. */
export async function paymentConnectionStatus(admin: SupabaseClient, restaurantId: string) {
  const configuration = paymentConnectionConfiguration();
  const environment = providerLiveMode() ? "production" : "test";
  const raw = await rpc(admin, "get_payment_account", { p_restaurant_id: restaurantId });
  const state = {
    ...configuration,
    environment,
    connectionEnvironment: null as "test" | "production" | null,
    readyForPayments: false,
    connectionIssue: "not_connected" as
      | "not_connected"
      | "inactive"
      | "different_environment"
      | "reconnect_required"
      | null,
    connection: { connected: false } as {
      connected: boolean;
      providerUserId?: string;
      expiresAt?: string;
    },
  };
  if (!raw) return state;
  const parsed = accountSchema.safeParse(raw);
  if (!parsed.success || parsed.data.restaurantId !== restaurantId || !parsed.data.isCurrent) {
    return { ...state, connectionIssue: "reconnect_required" as const };
  }
  const account = parsed.data;
  state.connection = {
    connected: account.active,
    providerUserId: account.providerUserId,
    expiresAt: account.expiresAt,
  };
  try {
    const credentials = await accountCredentials(account);
    state.connectionEnvironment = credentials.liveMode ? "production" : "test";
    state.connectionIssue = credentials.liveMode !== providerLiveMode()
      ? "different_environment"
      : account.active
      ? null
      : "inactive";
    state.readyForPayments = configuration.configured && state.connectionIssue === null;
  } catch {
    state.connectionIssue = "reconnect_required";
  }
  return state;
}

export async function paymentAccount(
  admin: SupabaseClient,
  lookup: AccountLookup,
  requireActive = false,
) {
  const raw = await rpc(
    admin,
    "get_payment_account",
    accountLookupArguments(lookup),
  );
  if (!raw) {
    throw new ApiError(409, "PAYMENT_NOT_CONNECTED", "El comercio debe conectar Mercado Pago.");
  }
  const account = accountSchema.parse(raw);
  if (
    ("accountId" in lookup && account.accountId !== lookup.accountId) ||
    ("restaurantId" in lookup && account.restaurantId !== lookup.restaurantId) ||
    ("providerUserId" in lookup && account.providerUserId !== lookup.providerUserId)
  ) throw new Error("Payment account lookup mismatch");
  if (requireActive && (!account.active || !account.isCurrent)) {
    throw new ApiError(409, "PAYMENT_NOT_CONNECTED", "El comercio debe conectar Mercado Pago.");
  }
  let credentials = await accountCredentials(account);
  if ("providerUserId" in lookup && lookup.liveMode !== undefined) {
    assertPaymentEnvironment(credentials.liveMode, lookup.liveMode);
  }
  // Historical attempts reconcile with their pinned account, even after a deployment mode change.
  if (requireActive) assertPaymentEnvironment(credentials.liveMode, providerLiveMode());
  if (Date.parse(account.expiresAt) <= Date.now() + 60_000) {
    const clientId = requireMercadoPagoClientId();
    const acquired = await rpc(admin, "acquire_payment_account_refresh", {
      p_account_id: account.accountId,
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
    const refresh = normalizeOAuthTokenResponse(
      await providerRequest("/oauth/token", undefined, {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: requireEnv("MERCADOPAGO_CLIENT_SECRET"),
        refresh_token: credentials.refreshToken,
      }),
      credentials.liveMode,
    );
    if (refresh.user_id !== account.providerUserId) {
      throw new Error("Provider refresh account mismatch");
    }
    await rpc(admin, "refresh_payment_account", {
      p_account_id: account.accountId,
      p_expected_expires_at: account.expiresAt,
      p_provider_user_id: account.providerUserId,
      p_encrypted_credentials: await encryptCredentials(
        {
          accessToken: refresh.access_token,
          refreshToken: refresh.refresh_token,
          liveMode: refresh.live_mode,
        },
        mpEncryptionKey(),
        account.restaurantId,
      ),
      p_expires_at: new Date(Date.now() + refresh.expires_in * 1000).toISOString(),
      p_live_mode: refresh.live_mode,
    });
    credentials = {
      accessToken: refresh.access_token,
      refreshToken: refresh.refresh_token,
      liveMode: refresh.live_mode,
    };
  }
  // A deployment can change while the provider refresh request is in flight.
  if (requireActive) assertPaymentEnvironment(credentials.liveMode, providerLiveMode());
  return { ...account, liveMode: credentials.liveMode, accessToken: credentials.accessToken };
}

/** Validate the current encrypted account before the transaction can reserve any stock. */
export async function beginPaymentCheckout(
  admin: SupabaseClient,
  input: {
    request: Record<string, unknown> & { restaurantSlug: string };
    ipHash: string;
    phoneHash: string;
    clientEventTokenHash: string;
    statusTokenHash: string;
  },
) {
  if (!paymentConnectionConfiguration().configured) {
    throw new ApiError(
      503,
      "PAYMENT_CONFIGURATION_ERROR",
      "La plataforma debe completar la configuración de cobros. Reintentá en unos minutos.",
    );
  }
  const { data: commerce, error } = await admin.from("restaurants").select("id").eq(
    "slug",
    input.request.restaurantSlug.trim().toLowerCase(),
  ).maybeSingle();
  const restaurantId = z.string().uuid().safeParse(commerce?.id);
  if (error || !restaurantId.success) {
    throw new ApiError(
      409,
      "ONLINE_CHECKOUT_NOT_READY",
      "El comercio no puede recibir pagos online.",
    );
  }
  const account = await paymentAccount(admin, { restaurantId: restaurantId.data }, true);
  const attempt = await rpc(admin, "begin_online_checkout", {
    p_request: input.request,
    p_ip_hash: input.ipHash,
    p_phone_hash: input.phoneHash,
    p_client_event_token_hash: input.clientEventTokenHash,
    p_status_token_hash: input.statusTokenHash,
    p_live_mode: account.liveMode,
    // The transaction rejects a concurrent change instead of reserving for an unchecked account.
    p_expected_account_id: account.accountId,
  });
  const pinned = z.object({
    accountId: z.string().uuid(),
    restaurantId: z.string().uuid(),
    liveMode: z.boolean(),
    checkoutUrl: z.string().nullable(),
  }).parse(attempt);
  if (
    pinned.restaurantId !== account.restaurantId || pinned.liveMode !== account.liveMode ||
    (pinned.checkoutUrl === null && pinned.accountId !== account.accountId)
  ) throw new Error("Checkout account/environment mismatch");
  // A replay with an existing preference keeps its original connection. Creating
  // a preference requires the exact connection validated before stock reservation.
  return { account, attempt };
}

export async function reconcileProviderPayment(
  admin: SupabaseClient,
  raw: unknown,
  account: { accountId: string; restaurantId: string; providerUserId: string; liveMode: boolean },
) {
  const payment = providerPaymentSchema.parse(raw);
  if (
    payment.collector_id !== account.providerUserId ||
    payment.live_mode !== account.liveMode
  ) throw new Error("Provider account/environment mismatch");
  if (!z.string().uuid().safeParse(payment.external_reference).success) return null; // A different integration's payment.
  const rawAttempt = await rpc(admin, "get_online_payment_attempt", {
    p_attempt_id: payment.external_reference,
  });
  if (!rawAttempt) return null;
  const attempt = paymentAttemptSchema.parse(rawAttempt);
  if (
    attempt.restaurantId !== account.restaurantId ||
    attempt.accountId !== account.accountId ||
    attempt.liveMode !== account.liveMode ||
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
      liveMode: payment.live_mode,
      accountId: account.accountId,
    },
  });
}

export async function reconcileAttempt(
  admin: SupabaseClient,
  attempt: z.infer<typeof paymentAttemptSchema>,
): Promise<void> {
  const account = await paymentAccount(admin, { accountId: attempt.accountId });
  if (account.restaurantId !== attempt.restaurantId || account.liveMode !== attempt.liveMode) {
    throw new Error("Payment attempt account/environment mismatch");
  }
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

/** The caller must verify the webhook signature before selecting a stored connection. */
export async function reconcilePaymentNotification(
  admin: SupabaseClient,
  event: { providerUserId: string; paymentId: string; liveMode?: boolean },
) {
  // A missing legacy mode is allowed only when the database has a single unambiguous account.
  const account = await paymentAccount(admin, {
    providerUserId: event.providerUserId,
    ...(event.liveMode === undefined ? {} : { liveMode: event.liveMode }),
  });
  const payment = await providerRequest(
    `/v1/payments/${encodeURIComponent(event.paymentId)}`,
    account.accessToken,
  );
  if (providerPaymentSchema.parse(payment).id !== event.paymentId) {
    throw new Error("Provider notification payment mismatch");
  }
  // Neither the notification body nor browser parameters can establish financial facts.
  await reconcileProviderPayment(admin, payment, account);
  return { restaurantId: account.restaurantId };
}

export { createAdminClient };
