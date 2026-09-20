// api/transcribe.js
//
// POST /api/transcribe
// Body: { "blobUrl": "https://...vercel-storage.com/...", "filename": "recording.webm", "contentType"?: "audio/webm" }
//
// The audio itself is NOT sent to this function — it was already uploaded
// directly to Vercel Blob by the browser (see api/blob-upload.js). This
// route just fetches those bytes server-side and forwards them to Groq's
// hosted Whisper endpoint, which is exactly what avoids the ~4.5MB Vercel
// Function request-body limit for the recording itself.
//
// Calls Groq's REST API directly via fetch() — no 'openai' npm package,
// no OpenAI dependency of any kind. Groq serves the real, open-source
// Whisper large-v3 model weights on their own hardware, with a genuine
// free tier (no card required).

import { jsonResponse, preflight } from '../lib/cors.js';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// whisper-large-v3-turbo is faster and fits Groq's free tier well; swap to
// whisper-large-v3 via env var if you want the (slower, more accurate)
// full model instead.
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';

// Groq's file size ceiling for a single transcription request. Real number
// documented by Groq at time of writing; if a Blob is bigger than this,
// there's no point even trying — return a clear, honest error naming the
// actual limit rather than letting the request fail deep inside the fetch
// to Groq with a vaguer message.
const GROQ_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

export async function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { blobUrl, filename, contentType: declaredContentType } = body || {};

  // ---- validate inputs explicitly, per the checklist ----
  if (!blobUrl || typeof blobUrl !== 'string') {
    return jsonResponse({ error: 'Missing or invalid blobUrl. Upload the audio to Blob storage first, then send its URL here.' }, { status: 400 });
  }
  try {
    new URL(blobUrl);
  } catch (e) {
    return jsonResponse({ error: 'blobUrl is not a valid URL.' }, { status: 400 });
  }
  const safeFilename = (typeof filename === 'string' && filename.trim()) ? filename.trim() : 'recording.webm';
  if (!process.env.GROQ_API_KEY) {
    return jsonResponse({ error: 'GROQ_API_KEY is not configured on the server. Set it in Vercel Project Settings -> Environment Variables and redeploy.' }, { status: 500 });
  }

  try {
    // ---- download the Blob safely and verify the response ----
    const audioRes = await fetch(blobUrl);
    if (!audioRes.ok) {
      if (audioRes.status === 401 || audioRes.status === 403) {
        throw new Error(
          `Could not retrieve the uploaded audio (HTTP ${audioRes.status}). This exact error means the Blob store connected to this project is set to PRIVATE, but the app uploads with access:'public'. Private Blob stores require authenticated reads, which this app deliberately does not implement (see README). Fix: in the Vercel dashboard, create a Blob store with PUBLIC access and connect that one instead — an existing store's access mode cannot be changed after creation.`
        );
      }
      throw new Error(`Could not retrieve the uploaded audio from storage (HTTP ${audioRes.status}).`);
    }
    const arrayBuffer = await audioRes.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) throw new Error('The uploaded audio file is empty.');
    if (arrayBuffer.byteLength > GROQ_MAX_FILE_BYTES) {
      throw new Error(`This file is ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB, which is over Groq's ${GROQ_MAX_FILE_BYTES / 1024 / 1024}MB limit per transcription request. Split it into smaller chunks first.`);
    }

    // Prefer the content type the browser actually recorded/selected
    // (passed explicitly by the client) over what storage reports, since
    // storage's declared type can be generic (e.g. application/octet-stream)
    // depending on how the upload was made.
    const contentType = declaredContentType || audioRes.headers.get('content-type') || 'audio/webm';
    const file = new File([arrayBuffer], safeFilename, { type: contentType });

    const form = new FormData();
    form.append('file', file);
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json'); // gives segment-level timestamps

    const groqRes = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `Groq responded with HTTP ${groqRes.status}`);
    }

    const transcription = await groqRes.json();
    const segments = Array.isArray(transcription.segments)
      ? transcription.segments.map((s) => ({ start: s.start, end: s.end, text: (s.text || '').trim() })).filter((s) => s.text.length > 0)
      : [];
    const text = (transcription.text || '').trim();

    // ---- honest no-speech handling: never fabricate a transcript ----
    if (!text && segments.length === 0) {
      return jsonResponse({ text: '', segments: [], hasSpeech: false, message: 'No recognizable speech was detected in this audio.' });
    }

    return jsonResponse({ text, segments, hasSpeech: true });
  } catch (err) {
    console.error('Transcription error:', err);
    return jsonResponse({ error: err.message || 'Transcription failed.' }, { status: 500 });
  }
}
