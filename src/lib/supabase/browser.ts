import { createBrowserClient } from '@supabase/ssr';

export function browserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Registration is not open yet. Try the local demo while the platform is being configured.');
  return createBrowserClient(url, key);
}
