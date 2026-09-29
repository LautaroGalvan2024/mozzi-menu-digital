import { createAdminClient } from "../_shared/clients.ts";
import { getMaintenanceSecret } from "../_shared/config.ts";
import { constantTimeEqual } from "../_shared/crypto.ts";
import { ApiError, databaseApiError, toApiError } from "../_shared/errors.ts";
import { jsonResponse, readJson, safeLog } from "../_shared/http.ts";
import { expireOrdersSchema, parseInput } from "../_shared/schemas.ts";

const MAX_BODY_BYTES = 2 * 1_024;

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID();
  try {
    if (request.method !== "POST") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
    }
    const suppliedSecret = request.headers.get("x-maintenance-secret") ?? "";
    if (!constantTimeEqual(suppliedSecret, getMaintenanceSecret())) {
      throw new ApiError(401, "INVALID_MAINTENANCE_AUTH", "Credencial de mantenimiento inválida.");
    }

    const input = parseInput(expireOrdersSchema, await readJson(request, MAX_BODY_BYTES));
    const before = new Date(Date.now() - input.olderThanMinutes * 60_000).toISOString();
    // The service client is created only after the dedicated maintenance secret is verified.
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("expire_orders", {
      p_before: before,
      p_limit: input.limit,
    });
    if (error) throw databaseApiError(error);
    const expiredCount = typeof data === "string" ? Number(data) : data;
    if (!Number.isSafeInteger(expiredCount) || expiredCount < 0) {
      throw new Error("Invalid expire_orders response");
    }
    safeLog("info", "orders.expired", requestId, { expiredCount });
    return jsonResponse({ expiredCount, before, requestId });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.status >= 500) safeLog("error", "orders.expire_failed", requestId);
    return jsonResponse({
      error: { code: apiError.code, message: apiError.message },
      requestId,
    }, apiError.status);
  }
});
