import { getAppBaseUrl } from "../_shared/config.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, toApiError } from "../_shared/errors.ts";
import { jsonResponse, safeLog } from "../_shared/http.ts";
import { decryptCredentials } from "../_shared/mercadopago-core.ts";
import {
  oauthCallbackMessage,
  safeOAuthProviderMetadata,
  safeTokenResponseMetadata,
} from "../_shared/mercadopago-errors.ts";
import {
  createAdminClient,
  exchangeAuthorizationCode,
  mpEncryptionKey,
  normalizeOAuthTokenResponse,
  rpc,
  saveProviderAccount,
} from "../_shared/mercadopago.ts";

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  let stage:
    | "request_validation"
    | "state_consumption"
    | "state_decryption"
    | "authorization_check"
    | "token_exchange"
    | "token_validation"
    | "account_save" = "request_validation";
  try {
    if (request.method !== "GET") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
    }
    const url = new URL(request.url);
    const state = z.string().min(40).max(100).regex(/^[A-Za-z0-9_-]+$/).parse(
      url.searchParams.get("state"),
    );
    const stateHash = await sha256Hex(state);
    stage = "state_consumption";
    const admin = createAdminClient();
    const stored = z.object({ encryptedPayload: z.string() }).parse(
      await rpc(admin, "consume_payment_oauth_state", { p_state_hash: stateHash }),
    );
    stage = "state_decryption";
    const payload = z.object({
      restaurantId: z.string().uuid(),
      actorId: z.string().uuid(),
      superAdminAal2: z.boolean(),
      verifier: z.string(),
      liveMode: z.boolean(),
    }).parse(await decryptCredentials(stored.encryptedPayload, mpEncryptionKey(), stateHash));
    // Recheck current permissions after the browser's round trip.
    stage = "authorization_check";
    const [
      { data: profile, error: profileError },
      { data: member, error: memberError },
      { data: platform, error: platformError },
    ] = await Promise.all([
      admin.from("profiles").select("active").eq("id", payload.actorId).maybeSingle(),
      admin.from("restaurant_members").select("role,status").eq(
        "restaurant_id",
        payload.restaurantId,
      ).eq("user_id", payload.actorId).maybeSingle(),
      admin.from("platform_user_roles").select("role").eq("user_id", payload.actorId).eq(
        "role",
        "super_admin",
      ).maybeSingle(),
    ]);
    if (
      profileError || memberError || platformError || !profile?.active ||
      !(member?.role === "restaurant_admin" && member.status === "active" ||
        platform && payload.superAdminAal2)
    ) throw new ApiError(403, "FORBIDDEN", "Ya no tenés permisos para conectar esta cuenta.");
    const resultUrl = new URL(`${getAppBaseUrl()}/admin/medios-de-pago`);
    if (url.searchParams.has("error")) resultUrl.searchParams.set("mp", "cancelled");
    else {
      const code = z.string().min(1).max(2048).parse(url.searchParams.get("code"));
      stage = "token_exchange";
      const exchange = await exchangeAuthorizationCode(code, payload.verifier, payload.liveMode);
      stage = "token_validation";
      const validatedToken = normalizeOAuthTokenResponse(
        exchange.rawToken,
        exchange.requestedLiveMode,
      );
      stage = "account_save";
      await saveProviderAccount(admin, payload.restaurantId, validatedToken);
      resultUrl.searchParams.set("mp", "connected");
      safeLog("info", "payment.account_connected", requestId, {
        restaurantId: payload.restaurantId,
      });
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: resultUrl.href,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    const failure = toApiError(error);
    const providerMetadata = {
      ...safeOAuthProviderMetadata(failure),
      ...safeTokenResponseMetadata(failure),
    };
    safeLog("error", "payment.connection_failed", requestId, {
      errorCode: failure.code,
      stage,
      ...providerMetadata,
    });
    return jsonResponse({
      error: {
        code: failure.code,
        message: oauthCallbackMessage(failure),
        details: { stage, ...providerMetadata },
      },
      requestId,
    }, failure.status);
  }
});
