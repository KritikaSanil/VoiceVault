// api/extract-url.js
//
// POST /api/extract-url
// Body: { "url": "https://example.com/article" }
// Response: { "title": "...", "url": "...", "text": "..." }
//
// Runs entirely server-side, so it doesn't hit the browser CORS wall a
// client-side fetch would. It still fails honestly for pages that require
// login, are paywalled, or render their content via client-side JS —
// Readability only sees the initial HTML response.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { jsonResponse, preflight } from '../lib/cors.js';

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

  const { url } = body || {};
  if (!url) return jsonResponse({ error: 'Missing url.' }, { status: 400 });

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return jsonResponse({ error: 'Invalid URL.' }, { status: 400 });
  }

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
      title: article.title || parsed.toString(),
      url: parsed.toString(),
      text: article.textContent.trim().replace(/\n{3,}/g, '\n\n'),
    });
  } catch (err) {
    console.error('Extraction error:', err);
    return jsonResponse({ error: err.message || 'Extraction failed.' }, { status: 422 });
  }
}
