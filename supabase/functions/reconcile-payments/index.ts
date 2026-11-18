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
import { PaymentMaintenanceService } from "../_shared/mercadopago-maintenance.ts";

const expirationReportSchema = z.object({
  expired: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  blockedCountCapped: z.boolean(),
  locked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  purgedTokens: z.number().int().nonnegative(),
});

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
    const service = new PaymentMaintenanceService({
      expire: async (limit, signal) =>
        expirationReportSchema.parse(
          await rpc(admin, "expire_online_reservations_report", {
            p_before: new Date().toISOString(),
            p_limit: limit,
          }, signal),
        ),
      list: async (limit, signal) =>
        z.array(z.object({ attemptId: z.string().uuid() }).passthrough()).parse(
          await rpc(admin, "list_online_reconciliation", { p_limit: limit }, signal),
        ),
      reconcile: (attempt, signal) =>
        reconcileAttempt(admin, paymentAttemptSchema.parse(attempt), signal),
      finish: async (attemptId, succeeded) => {
        await rpc(admin, "finish_online_reconciliation", {
          p_attempt_id: attemptId,
          p_succeeded: succeeded,
        }, AbortSignal.timeout(5000));
      },
      failed: (attemptId) =>
        safeLog("error", "payment.reconciliation_failed", requestId, { attemptId }),
    });
    const result = await service.run(input.limit);
    const environment = providerLiveMode() ? "production" : "test";
    safeLog(result.expiration.blocked ? "warn" : "info", "payment.maintenance", requestId, {
      reconciled: result.reconciled,
      failed: result.failed,
      expired: result.expired,
      deferred: result.deferred,
      expirationBlocked: result.expiration.blocked,
      expirationLocked: result.expiration.locked,
      expirationFailed: result.expiration.failed,
      durationMs: result.durationMs,
      environment,
    });
    return jsonResponse(
      { ...result, environment, requestId },
      result.failed || result.expiration.failed || result.deferred ? 503 : 200,
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
