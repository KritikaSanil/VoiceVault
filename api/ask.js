// api/ask.js
//
// POST /api/ask
// Body: { "question": "...", "context": "<transcript or article text, optionally
//         timestamped as '[mm:ss] ...' lines>", "selectedSegments": [{start,end,text}]? }
// Response: { "answer": "...", "sources": [{ "timestamp": 12.3, "text": "..." }] }
//
// Calls Groq's REST API directly via fetch() — no 'openai' npm package, no
// OpenAI dependency of any kind. Groq hosts the real open-source Llama
// model weights on their own hardware. When the frontend explicitly passes
// selectedSegments (the user multi-selected specific transcript lines as
// context), we echo those back verbatim as `sources`, since those literally
// are the grounding text — no guessing. Otherwise the model is asked to
// cite [mm:ss] timestamps inline when the context includes them, which the
// frontend turns into clickable seek buttons by parsing the answer text —
// real citations grounded in the real timestamps that were actually sent,
// not a fabricated sources array.

import { jsonResponse, preflight } from '../lib/cors.js';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';

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

  const { question, context, selectedSegments } = body || {};
  if (!question || !context) return jsonResponse({ error: 'Missing question or context.' }, { status: 400 });
  if (!process.env.GROQ_API_KEY) {
    return jsonResponse({ error: 'GROQ_API_KEY is not configured on the server. Set it in Vercel Project Settings -> Environment Variables and redeploy.' }, { status: 500 });
  }

  try {
    const groqRes = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          {
            role: 'system',
            content: 'Answer the question using ONLY the source content the user provides. If the answer is not contained in it, say so plainly instead of guessing. If the source content includes [mm:ss] timestamp markers, cite the relevant one(s) inline in that exact [mm:ss] format when you reference something from it.',
          },
          { role: 'user', content: `SOURCE CONTENT:\n${String(context).slice(0, 12000)}\n\nQUESTION: ${question}` },
        ],
        temperature: 0.2,
      }),
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `Groq responded with HTTP ${groqRes.status}`);
    }

    const completion = await groqRes.json();
    const answer = completion.choices?.[0]?.message?.content || '';
    const payload = { answer };
    if (Array.isArray(selectedSegments) && selectedSegments.length) {
      payload.sources = selectedSegments.map((s) => ({ timestamp: s.start, text: s.text }));
    }
    return jsonResponse(payload);
  } catch (err) {
    console.error('Ask error:', err);
    return jsonResponse({ error: err.message || 'AI request failed.' }, { status: 500 });
  }
}
