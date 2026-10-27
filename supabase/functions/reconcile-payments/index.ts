import { getMaintenanceSecret } from "../_shared/config.ts";
import { constantTimeEqual } from "../_shared/crypto.ts";
import { z } from "../_shared/deps.ts";
import { ApiError, toApiError } from "../_shared/errors.ts";
import { jsonResponse, readJson, safeLog } from "../_shared/http.ts";
import {
  createAdminClient,
  paymentAttemptSchema,
  providerLiveMode,
  reconcileAttempt,
  rpc,
} from "../_shared/mercadopago.ts";
import { parseInput } from "../_shared/schemas.ts";

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  try {
    if (request.method !== "POST") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
    }
    if (
      !constantTimeEqual(request.headers.get("x-maintenance-secret") ?? "", getMaintenanceSecret())
    ) throw new ApiError(401, "INVALID_MAINTENANCE_AUTH", "Credencial inválida.");
    const input = parseInput(
      z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict(),
      await readJson(request, 2048),
    );
    const admin = createAdminClient();
    const attempts = z.array(z.unknown()).parse(
      await rpc(admin, "list_online_reconciliation", { p_limit: input.limit }),
    );
    let reconciled = 0;
    let failed = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, attempts.length) }, async () => {
      while (next < attempts.length) {
        const raw = attempts[next++];
        const reference = z.object({ attemptId: z.string().uuid() }).safeParse(raw);
        try {
          const attempt = paymentAttemptSchema.parse(raw);
          await reconcileAttempt(admin, attempt);
          reconciled++;
        } catch {
          failed++;
          safeLog("error", "payment.reconciliation_failed", requestId, {
            ...(reference.success ? { attemptId: reference.data.attemptId } : {}),
          });
          // Rotate failed attempts too: one disconnected seller must not starve
          // every other merchant's reconciliation queue. This never changes money.
          if (reference.success) {
            await rpc(admin, "mark_online_reconciled", { p_attempt_id: reference.data.attemptId });
          }
        }
      }
    }));
    const expired = await rpc(admin, "expire_online_reservations", {
      p_before: new Date().toISOString(),
      p_limit: input.limit,
    });
    const environment = providerLiveMode() ? "production" : "test";
    safeLog("info", "payment.maintenance", requestId, { reconciled, failed, environment });
    // Failed runs remain visible to the scheduler; reservations expire independently,
    // and a subsequently approved late payment must reacquire stock or require refund.
    return jsonResponse(
      { reconciled, failed, expired, environment, requestId },
      failed ? 503 : 200,
    );
  } catch (error) {
    const failure = toApiError(error);
    safeLog("error", "payment.maintenance_failed", requestId, { code: failure.code });
    return jsonResponse(
      { error: { code: failure.code, message: failure.message }, requestId },
      failure.status,
    );
  }
});
