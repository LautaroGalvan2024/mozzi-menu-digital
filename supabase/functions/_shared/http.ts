import { corsHeaders, preflightResponse, validateOrigin } from "./cors.ts";
import { ApiError, toApiError } from "./errors.ts";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export type RequestContext = {
  requestId: string;
  origin: string;
};

type Handler = (request: Request, context: RequestContext) => Promise<Response | unknown>;

type ServeOptions = {
  maxBodyBytes: number;
  handler: Handler;
  allowedMethods?: readonly string[];
};

function withHeaders(response: Response, origin: string, methods: readonly string[]): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  for (const [name, value] of corsHeaders(origin, methods)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}

export async function readJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere Content-Type application/json.");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBodyBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "El contenido enviado es demasiado grande.");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "El contenido enviado es demasiado grande.");
  }
  if (bytes.byteLength === 0) {
    throw new ApiError(400, "INVALID_JSON", "El cuerpo JSON es obligatorio.");
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "El cuerpo JSON no es válido.");
  }
}

export function validationError(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ApiError {
  const fields = issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  return new ApiError(422, "VALIDATION_ERROR", "Revisá los datos enviados.", { fields });
}

export function serve(options: ServeOptions): void {
  const methods = options.allowedMethods ?? ["POST", "OPTIONS"];
  Deno.serve(async (request) => {
    const requestId = crypto.randomUUID();
    let origin: string | undefined;
    try {
      if (request.method === "OPTIONS") return preflightResponse(request, methods);
      origin = validateOrigin(request);
      if (!methods.includes(request.method) || request.method === "OPTIONS") {
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
      }

      const result = await options.handler(request, { requestId, origin });
      const response = result instanceof Response ? result : jsonResponse(result);
      return withHeaders(response, origin, methods);
    } catch (error) {
      const apiError = toApiError(error);
      const payload: Record<string, unknown> = {
        error: { code: apiError.code, message: apiError.message },
        requestId,
      };
      if (apiError.details) {
        payload.error = { ...payload.error as object, details: apiError.details };
      }
      const response = jsonResponse(payload, apiError.status);

      if (origin) return withHeaders(response, origin, methods);
      try {
        const validated = validateOrigin(request);
        return withHeaders(response, validated, methods);
      } catch {
        return response;
      }
    }
  });
}

export function safeLog(
  level: "info" | "warn" | "error",
  event: string,
  requestId: string,
  metadata: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  const output = JSON.stringify({ event, requestId, ...metadata });
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.info(output);
}
