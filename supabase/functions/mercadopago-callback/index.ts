import { getAppBaseUrl } from "../_shared/config.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, toApiError } from "../_shared/errors.ts";
import { jsonResponse, safeLog } from "../_shared/http.ts";
import { decryptCredentials } from "../_shared/mercadopago-core.ts";
import {
  createAdminClient,
  exchangeAuthorizationCode,
  mpEncryptionKey,
  rpc,
  saveProviderAccount,
} from "../_shared/mercadopago.ts";

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  try {
    if (request.method !== "GET") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
    }
    const url = new URL(request.url);
    const state = z.string().min(40).max(100).regex(/^[A-Za-z0-9_-]+$/).parse(
      url.searchParams.get("state"),
    );
    const stateHash = await sha256Hex(state);
    const admin = createAdminClient();
    const stored = z.object({ encryptedPayload: z.string() }).parse(
      await rpc(admin, "consume_payment_oauth_state", { p_state_hash: stateHash }),
    );
    const payload = z.object({
      restaurantId: z.string().uuid(),
      actorId: z.string().uuid(),
      superAdminAal2: z.boolean(),
      verifier: z.string(),
    }).parse(await decryptCredentials(stored.encryptedPayload, mpEncryptionKey(), stateHash));
    // Recheck current permissions after the browser's round trip.
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
      const token = await exchangeAuthorizationCode(code, payload.verifier);
      await saveProviderAccount(admin, payload.restaurantId, token);
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
    safeLog("error", "payment.connection_failed", requestId);
    return jsonResponse({
      error: {
        code: failure.code,
        message:
          "No se pudo conectar Mercado Pago. Volvé al panel e iniciá la conexión nuevamente.",
      },
      requestId,
    }, failure.status);
  }
});
