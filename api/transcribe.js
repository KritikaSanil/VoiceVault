// api/transcribe.js
//
// POST /api/transcribe
// Body: {
//   "blobUrl":  "https://<store>.public.blob.vercel-storage.com/...",   // a small, already-prepared audio chunk
//   "filename": "chunk-1.wav",
//   "contentType"?: "audio/wav",
//   "language"?: "en" | "hi" | "mr" | any ISO-639-1 code,   // omit (or "auto") to let Whisper detect it
//   "prompt"?:   "names, terms, course words ...",          // optional context, only what the user supplied
//   "wordTimestamps"?: boolean                              // optional word-level timing
// }
//
// The browser decodes the media, converts it to clean 16 kHz mono WAV, splits it into
// overlapping chunks and uploads each chunk to Vercel Blob (see api/blob-upload.js). This route
// fetches ONE chunk server-side and forwards it to Groq's hosted Whisper. It never sees a video
// file and never receives audio in the request body.
//
// Keeps Groq. GROQ_API_KEY stays server-side and is never logged or returned.

import { jsonResponse, preflight } from '../lib/cors.js';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Accuracy matters more than raw speed here, so the default is the full large-v3 model.
// GROQ_WHISPER_MODEL overrides it (e.g. whisper-large-v3-turbo for faster, slightly less accurate results).
const whisperModel = () => process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';

// Groq's per-request file limit on the free tier.
const GROQ_MAX_FILE_BYTES = 25 * 1024 * 1024;

// Vercel Blob public URLs live under *.blob.vercel-storage.com. Refusing any other host stops this route
// from being used to make the server fetch arbitrary URLs.
const BLOB_HOST = /(^|\.)blob\.vercel-storage\.com$/i;

// Blob token: the store connected to this project may use a custom env prefix (e.g. BLOB_1_).
const blobToken = () => process.env.BLOB_1_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function OPTIONS() {
  return preflight();
}

function fail(status, code, error, extra = {}) {
  return jsonResponse({ error, code, ...extra }, { status });
}

// Same rule the reference Whisper implementation uses to skip silence: a segment the model itself flags as
// "probably not speech" AND that it is unsure about. Without this, silence comes back as invented text
// ("Thank you for watching."). Segments are only dropped, never edited, and every timestamp stays as returned.
function isLikelyNoSpeech(seg) {
  const nsp = seg.no_speech_prob, lp = seg.avg_logprob;
  if (typeof nsp === 'number' && typeof lp === 'number' && nsp > 0.6 && lp < -1) return true;
  if (typeof nsp === 'number' && nsp > 0.95) return true;
  return false;
}

async function fetchWithRetry(makeRequest, { retries = 2, maxWaitSec = 12 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await makeRequest();
      if (res.status === 429) {
        const ra = parseFloat(res.headers.get('retry-after'));
        const waitSec = Number.isFinite(ra) ? ra : Math.pow(2, attempt + 1);
        if (attempt < retries && waitSec <= maxWaitSec) { await sleep(waitSec * 1000); continue; }
        return res; // out of retries, or the wait is too long to sit through inside one function call
      }
      if (res.status >= 500 && attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
    }
  }
  throw lastErr || new Error('Request failed.');
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, 'bad_request', 'Invalid JSON body.'); }

  const { blobUrl, filename, contentType: declaredContentType, language, prompt, wordTimestamps } = body || {};

  // ---- validate inputs ----
  if (!blobUrl || typeof blobUrl !== 'string') return fail(400, 'bad_request', 'Missing or invalid blobUrl. Upload the audio to Blob storage first, then send its URL here.');
  let parsed;
  try { parsed = new URL(blobUrl); } catch (e) { return fail(400, 'bad_request', 'blobUrl is not a valid URL.'); }
  if (parsed.protocol !== 'https:' || !BLOB_HOST.test(parsed.hostname)) return fail(400, 'bad_request', 'blobUrl must be a Vercel Blob URL.');
  if (language != null && language !== '' && language !== 'auto' && !/^[a-z]{2}$/.test(String(language))) return fail(400, 'bad_request', 'language must be an ISO-639-1 code such as "en", "hi" or "mr", or "auto".');
  if (!process.env.GROQ_API_KEY) return fail(500, 'not_configured', 'GROQ_API_KEY is not configured on the server. Set it in Vercel Project Settings -> Environment Variables and redeploy.');

  const safeFilename = (typeof filename === 'string' && filename.trim()) ? filename.trim().replace(/[^\w.\- ]+/g, '_') : 'audio.wav';

  try {
    // ---- download the prepared chunk ----
    let audioRes;
    try { audioRes = await fetchWithRetry(() => fetch(blobUrl), { retries: 2 }); }
    catch (e) { return fail(502, 'download_failed', 'Could not retrieve the uploaded audio from storage.'); }
    if (!audioRes.ok) {
      if (audioRes.status === 401 || audioRes.status === 403) {
        return fail(502, 'download_failed', `Could not retrieve the uploaded audio (HTTP ${audioRes.status}). This usually means the connected Blob store is PRIVATE; this app uploads with access:'public'. Create a Blob store with PUBLIC access and connect that one instead (an existing store's access mode cannot be changed).`);
      }
      return fail(502, 'download_failed', `Could not retrieve the uploaded audio from storage (HTTP ${audioRes.status}).`);
    }
    const bytes = await audioRes.arrayBuffer();
    if (!bytes || bytes.byteLength === 0) return fail(400, 'bad_request', 'The uploaded audio file is empty.');
    if (bytes.byteLength > GROQ_MAX_FILE_BYTES) {
      return fail(413, 'too_large', `This audio is ${(bytes.byteLength / 1048576).toFixed(1)}MB, over Groq's ${GROQ_MAX_FILE_BYTES / 1048576}MB per-request limit. The app normally splits audio into small chunks before it gets here.`);
    }
    const contentType = declaredContentType || audioRes.headers.get('content-type') || 'audio/wav';

    // ---- transcribe with Groq Whisper ----
    const model = whisperModel();
    const makeForm = () => {
      const form = new FormData();
      form.append('file', new File([bytes], safeFilename, { type: contentType }));
      form.append('model', model);
      form.append('response_format', 'verbose_json');   // segment timestamps + per-segment confidence
      form.append('temperature', '0');                   // deterministic decoding
      form.append('timestamp_granularities[]', 'segment');
      if (wordTimestamps) form.append('timestamp_granularities[]', 'word');
      if (language && language !== 'auto') form.append('language', String(language));   // never forced when Auto
      if (typeof prompt === 'string' && prompt.trim()) form.append('prompt', prompt.trim().slice(0, 700));
      return form;
    };
    let groqRes;
    try {
      groqRes = await fetchWithRetry(() => fetch(GROQ_TRANSCRIBE_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: makeForm() }), { retries: 2 });
    } catch (e) {
      return fail(502, 'groq_error', 'Could not reach the transcription service. Please try again.');
    }

    if (!groqRes.ok) {
      const errBody = await groqRes.json().catch(() => ({}));
      const message = errBody?.error?.message || `Groq responded with HTTP ${groqRes.status}`;
      if (groqRes.status === 429) {
        const ra = parseFloat(groqRes.headers.get('retry-after'));
        return fail(429, 'rate_limited', message, { retryAfter: Number.isFinite(ra) ? ra : 20 });
      }
      return fail(groqRes.status >= 500 ? 502 : 400, 'groq_error', message);
    }

    const t = await groqRes.json();
    let segments = Array.isArray(t.segments) ? t.segments : [];
    let timingApproximate = false;
    if (!segments.length && (t.text || '').trim()) {
      // Whisper returned text without segment timing (not expected with verbose_json). Use the chunk's true bounds.
      segments = [{ start: 0, end: Number(t.duration) || 0, text: t.text }];
      timingApproximate = true;
    }
    const kept = segments.filter((s) => (s.text || '').trim() && !isLikelyNoSpeech(s));
    const out = kept.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
    const payload = {
      text: out.map((s) => s.text).join(' ').trim(),
      segments: out,
      hasSpeech: out.length > 0,
      language: t.language || null,
      duration: typeof t.duration === 'number' ? t.duration : null,
      dropped: segments.length - kept.length,
      model,
    };
    if (timingApproximate) payload.timingApproximate = true;
    if (wordTimestamps && Array.isArray(t.words)) payload.words = t.words.map((w) => ({ start: w.start, end: w.end, word: w.word }));

    // The chunk was only needed for this request; remove it (best effort). Failed attempts are left in place
    // so the browser can retry the same URL.
    const token = blobToken();
    if (token) {
      try { const { del } = await import('@vercel/blob'); await del(blobUrl, { token }); } catch (e) { /* not fatal */ }
    }

    return jsonResponse(payload);
  } catch (err) {
    console.error('Transcription error:', err && err.message ? err.message : 'unknown');   // message only: never the key
    return fail(500, 'server_error', 'Transcription failed on the server.');
  }
}
