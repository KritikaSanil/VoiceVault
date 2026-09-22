// api/health.js
// GET /api/health -> { status: "ok", groqConfigured, blobConfigured, whisperModel }
// Used by Settings -> "Test connection". Reports only WHETHER each setting exists, never its value.

import { jsonResponse, preflight } from '../lib/cors.js';

export async function OPTIONS() {
  return preflight();
}

export async function GET() {
  return jsonResponse({
    status: 'ok',
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    blobConfigured: Boolean(process.env.BLOB_1_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN),
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3',
  });
}
