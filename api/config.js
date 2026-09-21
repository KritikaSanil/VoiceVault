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
// If SUPABASE_URL / SUPABASE_ANON_KEY aren't set, the app runs in
// "guest mode": no accounts, no auth walls, everything behaves exactly like
// before this feature existed. That's a deliberate choice — we don't want
// adding auth to brick the app for anyone who hasn't set up Supabase yet.

import { jsonResponse, preflight } from '../lib/cors.js';

export async function OPTIONS() {
  return preflight();
}

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const authConfigured = Boolean(supabaseUrl && supabaseAnonKey);

  if (!authConfigured) {
    return jsonResponse({ authConfigured: false });
  }
  return jsonResponse({ authConfigured: true, supabaseUrl, supabaseAnonKey });
}
