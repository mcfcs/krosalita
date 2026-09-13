// Supabase client, created only when env vars are present so the app still
// builds/runs as a pure SPA (Browse + local play) without a backend configured.
import { createClient } from '@supabase/supabase-js';

// import.meta.env is a Vite-only object. Under bare Node — which is how every harness in
// scripts/ runs — it is undefined, so reading a property off it threw and made every
// module that transitively imports this one unimportable outside the bundler.
const env = (typeof import.meta !== 'undefined' && import.meta.env)
  || (typeof globalThis !== 'undefined' && globalThis.process && globalThis.process.env)
  || {};

const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

export const supabaseEnabled = Boolean(url && anonKey);

export const supabase = supabaseEnabled
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null;
