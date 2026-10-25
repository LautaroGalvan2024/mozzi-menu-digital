import { z } from "./deps.ts";
import { ApiError } from "./errors.ts";
import { parseOrderResult, parseOrderRpcMetadata } from "./order-result.ts";
import { buildWhatsapp } from "./whatsapp.ts";

const recoveryRequestSchema = z.object({
  actionId: z.string().uuid(),
  recoveryToken: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export function recoveryUnavailable(): ApiError {
  return new ApiError(404, "RECOVERY_NOT_AVAILABLE", "Esta confirmación no está disponible.");
}

export function parseRecoveryRequest(input: unknown) {
  const result = recoveryRequestSchema.safeParse(input);
  if (!result.success) throw recoveryUnavailable();
  return result.data;
}

export function orderConfirmationResponse(
  data: unknown,
  appBaseUrl: string,
  tokens: {
    clientEventToken: string | null;
    clientEventExpiresAtFallback?: string;
    recoveryToken?: string;
  },
) {
  const metadata = parseOrderRpcMetadata(data);
  const result = parseOrderResult(data);
  const record = data as Record<string, unknown>;
  let recoveryExpiresAt: string | undefined;
  if (record.recoveryTokenStored === true) {
    if (
      typeof record.recoveryExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(record.recoveryExpiresAt)) || !tokens.recoveryToken
    ) {
      throw new ApiError(500, "INVALID_DATABASE_RESPONSE", "No se pudo validar la confirmación.");
    }
    recoveryExpiresAt = record.recoveryExpiresAt;
  }
  const clientEventExpiresAt = metadata.clientEventExpiresAt ??
    tokens.clientEventExpiresAtFallback ?? recoveryExpiresAt;
  if (!clientEventExpiresAt || !Number.isFinite(Date.parse(clientEventExpiresAt))) {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", "No se pudo validar la confirmación.");
  }
  return {
    order: {
      actionId: result.canonical.actionId,
      displayNumber: result.canonical.displayNumber,
      status: result.status,
      totalCents: result.canonical.totalCents,
      currencyCode: result.canonical.currencyCode,
      createdAt: result.canonical.createdAt,
    },
    whatsapp: buildWhatsapp(result.canonical, appBaseUrl),
    clientEventToken: metadata.clientEventTokenStored ? tokens.clientEventToken : null,
    clientEventExpiresAt,
    idempotentReplay: result.idempotentReplay,
    ...(recoveryExpiresAt ? { recoveryToken: tokens.recoveryToken!, recoveryExpiresAt } : {}),
  };
}
