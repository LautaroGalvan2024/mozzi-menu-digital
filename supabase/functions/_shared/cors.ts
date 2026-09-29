import { getAllowedOrigins } from "./config.ts";
import { ApiError } from "./errors.ts";

const ALLOWED_HEADERS = [
  "authorization",
  "apikey",
  "content-type",
  "x-client-info",
  "x-retry-count",
  "traceparent",
  "tracestate",
  "baggage",
].join(", ");

export function validateOrigin(
  request: Request,
  allowedOrigins: ReadonlySet<string> = getAllowedOrigins(),
): string {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.has(origin)) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Origen no permitido.");
  }
  return origin;
}

export function corsHeaders(
  origin: string,
  methods: readonly string[] = ["POST", "OPTIONS"],
): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  headers.set("Access-Control-Allow-Methods", methods.join(", "));
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return headers;
}

export function preflightResponse(
  request: Request,
  methods: readonly string[] = ["POST", "OPTIONS"],
): Response {
  const origin = validateOrigin(request);
  return new Response(null, { status: 204, headers: corsHeaders(origin, methods) });
}
