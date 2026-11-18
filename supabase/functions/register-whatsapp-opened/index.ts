import { createAdminClient } from "../_shared/clients.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, databaseApiError } from "../_shared/errors.ts";
import { safeLog, serve } from "../_shared/http.ts";
import { parseInput, registerWhatsappOpenedSchema } from "../_shared/schemas.ts";

const resultSchema = z.object({
  registered: z.boolean().optional().default(false),
  idempotentReplay: z.boolean().optional().default(false),
  alreadyAdvanced: z.boolean().optional().default(false),
  code: z.string().optional(),
}).passthrough();

serve({
  name: "register-whatsapp-opened",
  maxBodyBytes: 4 * 1_024,
  handler: async (_request, context) => {
    const input = parseInput(registerWhatsappOpenedSchema, await context.readJson());
    const tokenHash = await sha256Hex(input.clientEventToken);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("register_whatsapp_opened", {
      p_action_id: input.actionId,
      p_token_hash: tokenHash,
    });
    if (error) throw databaseApiError(error);
    const parsed = resultSchema.safeParse(data);
    if (!parsed.success) throw new Error("Invalid register_whatsapp_opened response");
    if (parsed.data.code === "INVALID_OR_EXPIRED_TOKEN") {
      throw new ApiError(401, "INVALID_OR_EXPIRED_TOKEN", "El token venció o no es válido.");
    }

    safeLog("info", "order.whatsapp_opened", context.requestId, {
      actionId: input.actionId,
      registered: parsed.data.registered,
    });
    return {
      registered: parsed.data.registered,
      idempotentReplay: parsed.data.idempotentReplay,
      alreadyAdvanced: parsed.data.alreadyAdvanced,
    };
  },
});
