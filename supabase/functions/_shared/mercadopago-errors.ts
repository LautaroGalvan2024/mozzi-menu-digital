import { ApiError } from "./errors.ts";

const MAX_OAUTH_ERROR_BYTES = 8192;
const OAUTH_ERRORS = {
  invalid_client: {
    code: "PAYMENT_OAUTH_INVALID_CLIENT",
    message:
      "Mercado Pago rechazó las credenciales de la aplicación. Revisá que Client ID y Client Secret correspondan a la misma aplicación y reconectá desde el panel.",
  },
  invalid_grant: {
    code: "PAYMENT_OAUTH_INVALID_GRANT",
    message:
      "La autorización venció, ya se utilizó o no coincide con la aplicación o su URL de retorno. Iniciá una conexión nueva desde el panel; si se repite, revisá la URL de redirección.",
  },
  invalid_request: {
    code: "PAYMENT_OAUTH_INVALID_REQUEST",
    message:
      "Mercado Pago rechazó los parámetros de conexión. Revisá la configuración OAuth y PKCE de la aplicación e iniciá una conexión nueva desde el panel.",
  },
  unauthorized_client: {
    code: "PAYMENT_OAUTH_UNAUTHORIZED_CLIENT",
    message:
      "La aplicación no tiene autorización para conectar esta cuenta. Revisá sus permisos OAuth e iniciá una conexión nueva desde el panel.",
  },
  invalid_scope: {
    code: "PAYMENT_OAUTH_INVALID_SCOPE",
    message:
      "Mercado Pago rechazó los permisos solicitados. Revisá los permisos OAuth de la aplicación e iniciá una conexión nueva desde el panel.",
  },
  unsupported_grant_type: {
    code: "PAYMENT_OAUTH_UNSUPPORTED_GRANT_TYPE",
    message:
      "Mercado Pago no admite el flujo de autorización solicitado. Revisá la configuración OAuth de la aplicación.",
  },
  forbidden: {
    code: "PAYMENT_OAUTH_FORBIDDEN",
    message:
      "Mercado Pago no permitió conectar esta cuenta. Revisá que la cuenta pueda autorizar esta aplicación e iniciá una conexión nueva desde el panel.",
  },
  local_rate_limited: {
    code: "PAYMENT_OAUTH_RATE_LIMITED",
    message:
      "Mercado Pago limitó temporalmente los intentos de conexión. Esperá unos minutos e iniciá una conexión nueva desde el panel.",
  },
} as const;
type OAuthErrorCode = keyof typeof OAUTH_ERRORS;
const TOKEN_RESPONSE_MESSAGE =
  "Mercado Pago devolvió credenciales incompletas o inválidas. La plataforma debe revisar la integración antes de volver a conectar.";
const TOKEN_FIELDS = [
  "access_token",
  "refresh_token",
  "expires_in",
  "live_mode",
  "user_id",
] as const;
const VALUE_TYPES = [
  "undefined",
  "null",
  "string",
  "number",
  "boolean",
  "object",
  "array",
] as const;

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return VALUE_TYPES.includes(type as typeof VALUE_TYPES[number]) ? type : "undefined";
}

export function invalidTokenResponse(
  raw: unknown,
  invalidFields: readonly PropertyKey[],
): ApiError {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return new ApiError(502, "PAYMENT_TOKEN_RESPONSE_INVALID", TOKEN_RESPONSE_MESSAGE, {
    accessTokenPresent: Object.hasOwn(record, "access_token"),
    refreshTokenPresent: Object.hasOwn(record, "refresh_token"),
    expiresInType: valueType(record.expires_in),
    liveModeType: valueType(record.live_mode),
    userIdType: valueType(record.user_id),
    invalidFields: TOKEN_FIELDS.filter((field) => invalidFields.includes(field)).join(","),
  });
}

export function safeTokenResponseMetadata(error: ApiError): Record<string, string | boolean> {
  if (error.code !== "PAYMENT_TOKEN_RESPONSE_INVALID") return {};
  const metadata: Record<string, string | boolean> = {};
  for (const name of ["accessTokenPresent", "refreshTokenPresent"] as const) {
    const value = error.details?.[name];
    if (typeof value === "boolean") metadata[name] = value;
  }
  for (const name of ["expiresInType", "liveModeType", "userIdType"] as const) {
    const value = error.details?.[name];
    if (typeof value === "string" && VALUE_TYPES.includes(value as typeof VALUE_TYPES[number])) {
      metadata[name] = value;
    }
  }
  const invalidFields = error.details?.invalidFields;
  if (typeof invalidFields === "string") {
    const fields = invalidFields.split(",");
    metadata.invalidFields = TOKEN_FIELDS.filter((field) => fields.includes(field)).join(",");
  }
  return metadata;
}

function recognizedError(value: unknown): value is OAuthErrorCode {
  return typeof value === "string" && Object.hasOwn(OAUTH_ERRORS, value);
}

async function readOAuthError(response: Response): Promise<OAuthErrorCode | "unknown"> {
  if (!response.body) return "unknown";
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_OAUTH_ERROR_BYTES
  ) {
    void response.body.cancel().catch(() => undefined);
    return "unknown";
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_OAUTH_ERROR_BYTES);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_OAUTH_ERROR_BYTES - length) {
        void reader.cancel().catch(() => undefined);
        return "unknown";
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    );
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const error = (decoded as Record<string, unknown>).error;
      if (recognizedError(error)) return error;
    }
  } catch {
    void reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  return "unknown";
}

/** Extract only a fixed OAuth enum; provider descriptions, causes and values are never retained. */
export async function oauthProviderFailure(response: Response): Promise<ApiError> {
  const providerError = await readOAuthError(response);
  const mapped = recognizedError(providerError) ? OAUTH_ERRORS[providerError] : null;
  return new ApiError(
    response.status >= 500 || response.status === 429 ? 503 : 409,
    mapped?.code ?? "PAYMENT_PROVIDER_ERROR",
    mapped?.message ??
      "Mercado Pago no pudo completar la operación. Revisá la conexión del comercio o reintentá.",
    { providerStatus: response.status, providerError },
  );
}

export function safeOAuthProviderMetadata(error: ApiError): Record<string, string | number> {
  const status = error.details?.providerStatus;
  const providerError = error.details?.providerError;
  const metadata: Record<string, string | number> = {};
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    metadata.providerStatus = status;
  }
  if (providerError === "unknown" || recognizedError(providerError)) {
    metadata.providerError = providerError;
  }
  return metadata;
}

export function oauthCallbackMessage(error: ApiError): string {
  if (error.code === "PAYMENT_TOKEN_RESPONSE_INVALID") return TOKEN_RESPONSE_MESSAGE;
  const mapped = Object.values(OAUTH_ERRORS).find((value) => value.code === error.code);
  // Comparing against the canonical message prevents even a forged ApiError from reflecting text.
  if (mapped && mapped.message === error.message) return error.message;
  return "No se pudo conectar Mercado Pago. Volvé al panel e iniciá la conexión nuevamente.";
}
