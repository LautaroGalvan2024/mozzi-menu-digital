import { ApiError } from "./errors.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function env(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
}

function injectedKey(name: "SUPABASE_PUBLISHABLE_KEYS" | "SUPABASE_SECRET_KEYS"): string {
  const raw = requireEnv(name);
  let keys: unknown;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }

  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error(`${name} must be a JSON object`);
  }

  const value = (keys as Record<string, unknown>).default;
  const expectedPrefix = name === "SUPABASE_PUBLISHABLE_KEYS" ? "sb_publishable_" : "sb_secret_";
  if (typeof value !== "string" || !value.startsWith(expectedPrefix) || /[\r\n]/.test(value)) {
    throw new Error(`${name} must contain a valid default key`);
  }
  return value;
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }
  return value;
}

function assertHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }

  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname))
  ) {
    throw new Error(`${label} must use HTTPS (HTTP is accepted only for loopback development)`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain URL credentials`);
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function getSupabaseUrl(): string {
  return assertHttpUrl(requireEnv("SUPABASE_URL"), "SUPABASE_URL");
}

export function getPublishableKey(): string {
  return injectedKey("SUPABASE_PUBLISHABLE_KEYS");
}

/** Read only after the caller has been authenticated and authorized. */
export function getSecretKey(): string {
  return injectedKey("SUPABASE_SECRET_KEYS");
}

export function getAppBaseUrl(): string {
  return assertHttpUrl(requireEnv("APP_BASE_URL"), "APP_BASE_URL");
}

export function parseAllowedOrigins(raw: string): ReadonlySet<string> {
  const origins = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = new URL(item);
      if (
        parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username ||
        parsed.password
      ) {
        throw new Error("APP_ALLOWED_ORIGINS entries must contain only scheme, host, and port");
      }
      if (
        parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname))
      ) {
        throw new Error("APP_ALLOWED_ORIGINS only accepts HTTPS or loopback HTTP origins");
      }
      return parsed.origin;
    });

  if (origins.length === 0) {
    throw new Error("APP_ALLOWED_ORIGINS must contain at least one origin");
  }
  if (origins.includes("*")) {
    throw new Error("Wildcard CORS origins are forbidden");
  }
  return new Set(origins);
}

export function getAllowedOrigins(): ReadonlySet<string> {
  return parseAllowedOrigins(requireEnv("APP_ALLOWED_ORIGINS"));
}

export function getRateLimitSecret(): string {
  const secret = requireEnv("RATE_LIMIT_HASH_SECRET");
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("RATE_LIMIT_HASH_SECRET must contain at least 32 bytes");
  }
  return secret;
}

export function getMaintenanceSecret(): string {
  const secret = requireEnv("MAINTENANCE_SECRET");
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("MAINTENANCE_SECRET must contain at least 32 bytes");
  }
  return secret;
}

export function requireSecureAppBaseUrl(): string {
  try {
    return getAppBaseUrl();
  } catch {
    throw new ApiError(500, "SERVER_CONFIGURATION_ERROR", "El servicio no está configurado.");
  }
}
