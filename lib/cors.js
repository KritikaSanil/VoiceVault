// lib/cors.js
// Shared helpers used by every function under /api. Not a route itself —
// Vercel only turns files directly under /api into functions.

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
      ...(init.headers || {}),
    },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
