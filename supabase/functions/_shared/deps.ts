import type { Database } from "../../../src/types/database.generated.ts";
// deno-lint-ignore no-import-prefix -- Keep the SDK pinned here for every deployed Edge entry point.
import type { SupabaseClient as Client } from "npm:@supabase/supabase-js@2.117.2";
export type SupabaseClient = Client<Database>;
export { createClient } from "npm:@supabase/supabase-js@2.117.2";
export type { AuthError, PostgrestError, User } from "npm:@supabase/supabase-js@2.117.2";
export { z } from "npm:zod@4.6.7";
