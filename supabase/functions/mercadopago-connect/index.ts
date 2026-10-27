import { getAppBaseUrl, requireEnv } from "../_shared/config.ts";
import { randomToken, sha256Hex } from "../_shared/crypto.ts";
import { z } from "../_shared/deps.ts";
import { readJson, serve } from "../_shared/http.ts";
import { encryptCredentials, pkceChallenge } from "../_shared/mercadopago-core.ts";
import {
  authorizePaymentAdmin,
  createAdminClient,
  mpEncryptionKey,
  oauthRedirectUri,
  rpc,
} from "../_shared/mercadopago.ts";
import { parseInput } from "../_shared/schemas.ts";

serve({
  maxBodyBytes: 2048,
  handler: async (request) => {
    const input = parseInput(
      z.object({
        restaurantId: z.string().uuid(),
        action: z.enum(["connect", "disconnect", "status"]).default("status"),
      }).strict(),
      await readJson(request, 2048),
    );
    const actor = await authorizePaymentAdmin(request, input.restaurantId);
    const admin = createAdminClient();
    if (input.action === "status") {
      const connection = await rpc(actor.client, "get_payment_connection", {
        p_restaurant_id: input.restaurantId,
      });
      const configured = [
        "MERCADOPAGO_CLIENT_ID",
        "MERCADOPAGO_CLIENT_SECRET",
        "MERCADOPAGO_ENCRYPTION_KEY",
        "MERCADOPAGO_WEBHOOK_SECRET",
      ].every((key) => Boolean(Deno.env.get(key)?.trim()));
      return { connection, configured };
    }
    if (input.action === "disconnect") {
      await rpc(admin, "disconnect_payment_account", { p_restaurant_id: input.restaurantId });
      return { disconnected: true };
    }
    // Validate deployment configuration before storing state or sending the user away.
    requireEnv("MERCADOPAGO_CLIENT_SECRET");
    requireEnv("MERCADOPAGO_WEBHOOK_SECRET");
    getAppBaseUrl();
    const state = randomToken(32);
    const verifier = randomToken(48);
    const stateHash = await sha256Hex(state);
    await rpc(admin, "save_payment_oauth_state", {
      p_state_hash: stateHash,
      p_encrypted_payload: await encryptCredentials(
        {
          restaurantId: input.restaurantId,
          actorId: actor.user.id,
          superAdminAal2: actor.authorization.isSuperAdmin,
          verifier,
        },
        mpEncryptionKey(),
        stateHash,
      ),
    });
    const url = new URL("https://auth.mercadopago.com/authorization");
    url.search = new URLSearchParams({
      client_id: requireEnv("MERCADOPAGO_CLIENT_ID"),
      response_type: "code",
      platform_id: "mp",
      state,
      redirect_uri: oauthRedirectUri(),
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: url.href };
  },
});
