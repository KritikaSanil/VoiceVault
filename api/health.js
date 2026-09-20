// api/health.js
// GET /api/health -> { "status": "ok" }
// Used by the frontend's Settings -> "Test connection" button.

import { jsonResponse, preflight } from '../lib/cors.js';

export async function OPTIONS() {
  return preflight();
}

export async function GET() {
  return jsonResponse({ status: 'ok' });
}
