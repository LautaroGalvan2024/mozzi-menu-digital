import { z } from "./deps.ts";
import { ApiError } from "./errors.ts";

const orderRateLimitResultSchema = z.object({
  allowed: z.boolean(),
  code: z.string().nullable(),
}).strict();

export function assertOrderRateLimitAllowed(data: unknown): void {
  const parsed = orderRateLimitResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(500, "INVALID_DATABASE_RESPONSE", "No se pudo validar la solicitud.");
  }
  if (parsed.data.allowed) return;

  if (parsed.data.code === "RESTAURANT_NOT_AVAILABLE") {
    throw new ApiError(404, "RESTAURANT_NOT_FOUND", "El restaurante no está disponible.");
  }
  if (parsed.data.code === "RATE_LIMITED") {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Demasiados intentos. Esperá unos minutos y volvé a intentar.",
    );
  }
  throw new ApiError(429, "RATE_LIMITED", "No se puede procesar la solicitud en este momento.");
}
