// api/extract-url.js
//
// POST /api/extract-url
// Body: { "url": "https://example.com/article" }
// Response (webpage): { "kind": "webpage", "title": "...", "url": "...", "text": "..." }
// Response (YouTube):  { "kind": "youtube", "title": "...", "url": "...", "videoId": "...",
//                        "text": "...", "segments": [{ "start": 0, "end": 3.2, "text": "..." }] }
//
// Webpage path runs entirely server-side (Readability), unchanged from
// before — still fails honestly for login/paywall/JS-rendered pages.
//
// YouTube path: this does NOT download or transcode any video/audio, and
// does NOT use Groq. It fetches the video's own public watch page (a plain
// server-side GET, same content any browser would receive) and reads the
// caption track YouTube already embeds in that page for videos that have
// captions (auto-generated or uploaded). This only works when a caption
// track exists. There is no officially documented public API for this —
// it relies on YouTube's page structure, which could change — so this is
// reported honestly, not as a guaranteed capability. Real audio download +
// Whisper transcription for arbitrary YouTube videos is NOT implemented:
// it would mean downloading full video/audio inside a Vercel Function,
// which is impractical (size/time limits) and legally murky for arbitrary
// third-party videos, so rather than fake that capability, videos with no
// captions honestly report the limitation instead.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { jsonResponse, preflight } from '../lib/cors.js';

export async function OPTIONS() {
  return preflight();
}

function extractYouTubeId(urlStr) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{6,})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{6,})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{6,})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{6,})/,
  ];
  for (const p of patterns) {
    const m = urlStr.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchYouTubeTranscript(videoId, originalUrl) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageRes = await fetch(watchUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!pageRes.ok) throw new Error(`Could not load the YouTube page (HTTP ${pageRes.status}).`);
  const html = await pageRes.text();

  const titleMatch = html.match(/"title":"((?:[^"\\]|\\.)*)"\s*,\s*"lengthSeconds"/);
  let title = titleMatch ? titleMatch[1] : null;
  if (!title) {
    const tagMatch = html.match(/<title>([^<]*)<\/title>/);
    title = tagMatch ? tagMatch[1].replace(/ - YouTube$/, '') : `YouTube video ${videoId}`;
  }
  title = title.replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\n/g, ' ');

  const tracksMatch = html.match(/"captionTracks":(\[[^\]]*\])/);
  if (!tracksMatch) {
    throw new Error('No captions are available for this video, so a transcript could not be retrieved. This app does not download/transcribe YouTube audio directly.');
  }

  let tracks;
  try {
    tracks = JSON.parse(tracksMatch[1]);
  } catch (e) {
    throw new Error('Could not read caption data for this video (YouTube may have changed its page format).');
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('No captions are available for this video, so a transcript could not be retrieved.');
  }

  const track = tracks.find((t) => (t.languageCode || '').startsWith('en')) || tracks[0];
  if (!track || !track.baseUrl) throw new Error('Could not find a usable caption track for this video.');

  const captionUrl = track.baseUrl.replace(/\\u0026/g, '&') + '&fmt=json3';
  const capRes = await fetch(captionUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!capRes.ok) throw new Error(`Could not download the caption track (HTTP ${capRes.status}).`);
  const capData = await capRes.json().catch(() => null);
  if (!capData || !Array.isArray(capData.events)) throw new Error('Caption data for this video was in an unexpected format.');

  const segments = [];
  for (const ev of capData.events) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const end = start + ((ev.dDurationMs || 0) / 1000);
    segments.push({ start, end, text });
  }
  if (segments.length === 0) throw new Error('This video has a caption track but it contained no readable text.');

  return {
    kind: 'youtube',
    title,
    url: originalUrl,
    videoId,
    text: segments.map((s) => s.text).join(' '),
    segments,
  };
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { url } = body || {};
  if (!url) return jsonResponse({ error: 'Missing url.' }, { status: 400 });

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return jsonResponse({ error: 'Invalid URL.' }, { status: 400 });
  }

  const youTubeId = extractYouTubeId(parsed.toString());
  if (youTubeId) {
    try {
      const result = await fetchYouTubeTranscript(youTubeId, parsed.toString());
      return jsonResponse(result);
    } catch (err) {
      console.error('YouTube extraction error:', err);
      return jsonResponse({ error: err.message || 'Could not extract this YouTube video.' }, { status: 422 });
    }
  }

  // ---- existing webpage path, unchanged ----
  try {
    const response = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VoiceVaultBot/1.0)' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`The site responded with HTTP ${response.status}.`);

    const html = await response.text();
    const dom = new JSDOM(html, { url: parsed.toString() });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.trim().length < 40) {
      throw new Error('No readable article content could be found on this page (it may require login, be paywalled, or render via JavaScript).');
    }

    return jsonResponse({
      kind: 'webpage',
      title: article.title || parsed.toString(),
      url: parsed.toString(),
      text: article.textContent.trim().replace(/\n{3,}/g, '\n\n'),
    });
  } catch (err) {
    console.error('Extraction error:', err);
    return jsonResponse({ error: err.message || 'Extraction failed.' }, { status: 422 });
  }
}
