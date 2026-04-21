import { createClient } from "@supabase/supabase-js";

/**
 * Server-only client using the service role key.
 * Bypasses RLS — use exclusively in trusted server code (cron jobs, Inngest functions).
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
