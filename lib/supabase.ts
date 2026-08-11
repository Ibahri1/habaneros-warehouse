import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}) : null;

export const isSupabaseConfigured = Boolean(supabase);

/**
 * Production login sequence:
 * 1. signInAnonymously() creates an unprivileged transport identity.
 * 2. api.login_with_pin verifies the one-way PIN hash and binds auth.uid().
 * 3. RLS uses that binding for all subsequent authorization.
 */
export async function loginWithPin(pin: string) {
  if (!supabase) throw new Error("Supabase environment variables are not configured.");
  const existing = await supabase.auth.getSession();
  if (!existing.data.session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }
  const { data, error } = await supabase.schema("api").rpc("login_with_pin", { input_pin: pin });
  if (error) throw error;
  return data;
}
