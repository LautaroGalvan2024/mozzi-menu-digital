import { createClient, type SupabaseClient } from "./deps.ts";
import { getPublishableKey, getSecretKey, getSupabaseUrl } from "./config.ts";

const AUTH_OPTIONS = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false,
} as const;

export function createUserClient(authorization: string): SupabaseClient {
  return createClient(getSupabaseUrl(), getPublishableKey(), {
    auth: AUTH_OPTIONS,
    global: { headers: { Authorization: authorization } },
  });
}

/** Must only be called after the request has passed the relevant authorization checks. */
export function createAdminClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSecretKey(), { auth: AUTH_OPTIONS });
}
