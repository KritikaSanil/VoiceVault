// api/config.js
//
// GET /api/config -> { authConfigured: boolean, supabaseUrl?, supabaseAnonKey? }
//
// Supabase's "anon" key is designed to be public (it's the key meant to ship
// in browser JS, gated by Row Level Security on the Supabase side) — it is
// NOT a secret like GROQ_API_KEY. This endpoint just avoids hardcoding it
// directly into index.html so the same static file works across
// environments (local/staging/prod) purely via Vercel env vars, same
// pattern as everything else in this project.
//
// Env var names: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are checked
// first (that's the naming this project's Supabase setup actually uses —
// the VITE_ prefix is just this project's chosen name for them; it carries
// no special meaning here since this app has no Vite build step, unlike in
// an actual Vite project where that prefix controls client exposure).
// SUPABASE_URL / SUPABASE_ANON_KEY are also accepted as a fallback for
// portability. If neither pair is set, the app runs in "guest mode": no
// accounts, no auth walls, everything behaves exactly like before this
// feature existed — deliberately, so adding auth can't brick the app for
// anyone who hasn't set up Supabase yet.

import { jsonResponse, preflight } from '../lib/cors.js';

export async function OPTIONS() {
  return preflight();
}

export async function GET() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
  const authConfigured = Boolean(supabaseUrl && supabaseAnonKey);

  if (!authConfigured) {
    return jsonResponse({ authConfigured: false });
  }
  return jsonResponse({ authConfigured: true, supabaseUrl, supabaseAnonKey });
}
