# VoiceVault — Vercel deployment (Groq-powered, no OpenAI)

A single Vercel project serving both the frontend (`index.html`) and the
API (`/api/*.js` serverless functions) from the same domain. Transcription
and Ask VoiceVault run on **Groq**, which hosts the real open-source
Whisper and Llama model weights on their own hardware with a genuine free
tier — no OpenAI key, no credit card.

## Folder structure (what you push to GitHub)

```
voicevault/
├── api/
│   ├── health.js         GET  /api/health
│   ├── blob-upload.js    POST /api/blob-upload   (token handshake for client uploads)
│   ├── transcribe.js     POST /api/transcribe    (real Whisper via Groq)
│   ├── extract-url.js    POST /api/extract-url   (real Readability extraction)
│   └── ask.js            POST /api/ask           (real Llama via Groq)
├── lib/
│   └── cors.js           shared response/CORS helpers (not a route)
├── index.html            the whole frontend, static
├── package.json
├── vercel.json           sets longer timeouts for the three API-calling routes
├── .env.example
└── .gitignore
```

Push this entire folder as a repo to GitHub, then import it in Vercel
(New Project → import the GitHub repo). No framework preset is needed —
Vercel auto-detects `/api/*.js` as functions and serves `index.html` as a
static file at `/`.

## Why Groq, and why not run Whisper inside Vercel itself

Whisper needs a PyTorch (or CTranslate2) runtime, gigabytes of model
weights in memory, and real CPU/GPU time per request — none of which fits
inside a Vercel Function's size and execution-time limits. Groq instead
hosts the actual open-source Whisper (`whisper-large-v3` /
`whisper-large-v3-turbo`) and Llama (`llama-3.3-70b-versatile`) model
weights on their own inference hardware, exposed through a plain HTTP API.
Calling that from a Vercel Function is just a `fetch()` — genuinely
practical regardless of how large the model behind it is. That's the
architecture here: Vercel never runs the model, it only calls out to it.

**Free-tier limits, honestly stated** (checked against Groq's published
limits, subject to change — see console.groq.com/docs for current numbers):
- Whisper: on the order of a few thousand requests and several hours of
  audio per day, rate-limited per minute.
- Llama chat: also free-tier with per-minute/per-day rate limits.
- No credit card required for either. This is a real standing free tier,
  not a time-limited trial — but it's explicitly not meant as
  production-scale infrastructure. If you outgrow it, Groq's paid tier is
  still far cheaper than OpenAI's Whisper API, or you can self-host
  (see "Alternative" below).

## Why large recordings don't go through a Function

Vercel Functions cap request bodies at ~4.5MB, which a multi-minute
recording blows past instantly. So the upload never touches a function at
all:

```
Record/Upload (browser)
  → upload() from @vercel/blob/client sends the file straight to
    Vercel Blob storage, authorized by a short-lived token from
    POST /api/blob-upload (which only ever sees metadata, not bytes)
  → browser gets back a public blob URL
  → browser POSTs { blobUrl, filename } (tiny JSON) to /api/transcribe
  → /api/transcribe fetches those bytes server-side and sends them to
    Groq's Whisper endpoint
  → returns { text, segments: [{ start, end, text }] }
  → frontend stores the transcript, makes it searchable, and syncs it to
    playback
```

## 1. Create a Blob store — it MUST be a PUBLIC store

In the Vercel dashboard: your project → **Storage** → **Create Database**
→ **Blob**. **When prompted for access mode, choose PUBLIC, not
Private.** Then connect it to this project — that automatically adds
`BLOB_READ_WRITE_TOKEN` to your project's environment variables.

**Why this matters, specifically:** Vercel now offers both Public and
Private Blob stores. This app's code uploads with `access: 'public'` and
`api/transcribe.js` fetches the resulting URL with a plain, unauthenticated
`fetch()` — which only works against a **public** store. Private Blob
stores require authenticated reads (short-lived OIDC tokens or signed
URLs), which this app deliberately does not implement, to keep the
architecture simple. If you connect a Private store instead, uploads and/or
transcription will fail with a clear error telling you exactly this — the
app cannot auto-detect or work around a Private store's access mode, since
that's enforced by Vercel's platform, not by anything in the code.

**A store's access mode cannot be changed after creation.** If you already
created a Private store, don't try to convert it — create a new Public one
and connect that instead.

## 2. Get a Groq API key (free, no card)

1. Go to [console.groq.com/keys](https://console.groq.com/keys)
2. Sign in / sign up (email is enough)
3. Create an API key, copy it (starts with `gsk_...`)

## 3. Environment variables to add in Vercel

Project → **Settings** → **Environment Variables**:

| Name | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | Yes | Used by `/api/transcribe` and `/api/ask`. Never exposed to the browser — only read inside the serverless functions. Confidential: treat it like a password, never commit it, never put it in frontend code. |
| `GROQ_WHISPER_MODEL` | No | Defaults to `whisper-large-v3-turbo`. |
| `GROQ_CHAT_MODEL` | No | Defaults to `llama-3.3-70b-versatile`. |
| `BLOB_READ_WRITE_TOKEN` | Auto-added | Added automatically when you connect a Blob store (step 1). |
| `SUPABASE_URL` | No | Enables real accounts (Supabase Auth). Omit both Supabase vars to run in guest mode — no login, nothing gated, identical to before this feature existed. |
| `SUPABASE_ANON_KEY` | No | From Supabase Project Settings -> API. This key is meant to be public (Row Level Security enforces access on Supabase's side) — it is safe to expose to the browser, unlike `GROQ_API_KEY`. |
| `ALLOWED_ORIGIN` | Optional | Leave unset (defaults to `*`) since frontend + API share one domain here. |

## Accounts (optional) — Supabase Auth

VoiceVault's login/signup screen uses [Supabase Auth](https://supabase.com/docs/guides/auth).
This is entirely optional:

- **Unset `SUPABASE_URL`/`SUPABASE_ANON_KEY`** → the app runs in guest mode.
  No sign-in screen, no gated actions — Record/Upload/Import/Ask/Library all
  work immediately, exactly as before this feature was added.
- **Set both** → a real sign-up/sign-in flow appears, and those same actions
  ask an unauthenticated visitor to create an account first.

To turn it on:

1. Create a free project at [supabase.com](https://supabase.com).
2. Project → **Settings → API** → copy the **Project URL** and the
   **anon public** key.
3. Add them to Vercel as `SUPABASE_URL` and `SUPABASE_ANON_KEY` and redeploy.
4. (Optional) Project → **Authentication → Providers** → enable Google if
   you want the "Continue with Google" button to work; it's shown either
   way but will error clearly if the provider isn't enabled.

**Important scope note:** this only adds accounts and gates actions behind
sign-in. Recordings, transcripts, notes, key moments, chapters and
knowledge cards still live in the browser's own localStorage/IndexedDB —
they are **not** synced to Supabase or split per-account. Signing in on a
different browser (or as a different user on the same browser) does not
give you a separate library; it's still whichever device's local storage
you're using. Turning this into real per-user cloud storage is a bigger
follow-up (a Postgres schema + Row Level Security policies + rewriting
every save/load call to hit a `/api/*` route instead of localStorage) —
ask if you want that built out next.


## 4. Set the Node.js version

Node 24 is GA on Vercel. Set it in two places:

1. **Project → Settings → Build and Deployment → Node.js Version → 24.x**
2. `package.json` already has `"engines": { "node": "24.x" }`

## 5. Deploy

Push to GitHub, import the repo in Vercel, and it deploys on every push.
Or from the CLI:

```bash
npm install -g vercel
vercel        # first deploy, links the project
vercel --prod # production deploy
```

## 6. Verify it's actually working

1. Open the site → **Settings → Backend** → **Test /api/health** → should
   say "Connected successfully."
2. Record a short clip → Save. It should move through **Transcribing…**
   → **Transcript ready** with real timestamped lines you can click to
   seek, and the waveform should reflect the actual recorded audio. If
   `GROQ_API_KEY` is missing/wrong, you'll see **TRANSCRIPTION FAILED**
   with the real error — not a fake success.
3. Paste a plain, non-paywalled article URL → Extract. Real extracted
   paragraphs, not placeholder text. Paywalled/login/JS-rendered pages
   correctly show "Couldn't extract this webpage" — expected, not a bug.
4. Open a source with a ready transcript and ask it a question. You
   should get a real Llama-generated answer, with `[mm:ss]` citations
   turned into clickable seek buttons where the model included them.

I have not run this deployment myself — I can't stand up infrastructure
from this environment, only write the code. Treat every status you see as
the real result of your own deployment.

## Local development

```bash
npm install
vercel dev
```

`vercel dev` proxies `/api/*` locally and reads `.env.local` (copy
`.env.example` there and fill in `GROQ_API_KEY`; run `vercel env pull` to
also fetch `BLOB_READ_WRITE_TOKEN` once the project is linked and a Blob
store is connected). Note: `onUploadCompleted` in `api/blob-upload.js`
only fires on a real deployment, since Blob calls that URL back over the
public internet — it's a no-op during `vercel dev`, which is fine since
the frontend doesn't depend on it either way.

## What's genuinely free vs. what could cost money

- **Free, no card, ever**: the Vercel Hobby plan for hosting this project,
  Vercel Blob's free storage allowance, and Groq's free tier for both
  Whisper and Llama, as long as you stay under their rate limits.
- **Could cost money**: if you exceed Groq's free-tier rate limits (heavy
  personal use is very unlikely to), their paid tier is metered and still
  far cheaper than OpenAI's; if you exceed Vercel's free Blob storage
  allowance; if you upgrade to a paid Vercel plan for longer function
  timeouts or more bandwidth than Hobby allows.

## Alternative: fully self-hosted, no third-party API at all

If you want zero dependency on Groq or any hosted provider, run
`faster-whisper` (CTranslate2, fast on CPU) and a small quantized LLM via
`llama.cpp` on a free-tier VM (Render/Fly.io). This is real and doable,
but honestly rougher: free-tier RAM (512MB–1GB) is tight even for a small
quantized model, free services spin down after inactivity (cold starts of
tens of seconds), and CPU-only inference is meaningfully slower than
Groq's hardware. It's a legitimate path if avoiding any third-party API is
a hard requirement for you, but it's more infrastructure to maintain for a
rougher result. This repo doesn't include that variant — say the word if
you want it built out instead of/alongside the Groq path.

## Known limits (real, not hypothetical)

- Groq's Whisper endpoint has its own file-size limit (in the tens of MB)
  — very long recordings may need chunking before transcription, which
  isn't implemented here.
- `/api/extract-url` can't get past logins, paywalls, or pages that render
  their content client-side via JavaScript — Readability only sees the
  initial HTML.
- No user accounts/auth — `onBeforeGenerateToken` in `api/blob-upload.js`
  currently authorizes every upload request. Fine for personal use; add
  real auth there before letting anyone else use this deployment.
- Groq's free-tier model lineup can change (their docs note some models
  are subject to free/developer-tier deprecation). If `GROQ_CHAT_MODEL`
  or `GROQ_WHISPER_MODEL` ever start failing, check
  console.groq.com/docs/models for current names and update the env var
  — no code change needed.


## Landing page, login page and media states

These are presentation changes in `index.html`; no `/api/*` file changed.

- **Landing page** is curated to six sections: hero (type plus a sample waveform that plays), the transcript (seekable
  waveform, timestamped lines that scroll with the playhead, search), Key Moments (one moment shown large), Ask
  VoiceVault (one answer), a small library preview, and a closing call to action. Everything on it is a labelled
  **sample** and never touches the app's real audio, transcript or AI code. The only continuous loop is the hero playhead;
  it sleeps when the hero is off-screen, the tab is hidden, the app is open, or `prefers-reduced-motion` is set.
- **Floating text.** Headings float up word by word, supporting text and labels follow on longer delays, and each block
  settles and stays (`.fl` elements in the markup carry `data-d` delay and `data-p` parallax depth, at most 10px).
  It is one `IntersectionObserver` plus one component on the same ticker, which only runs while you scroll. With
  `prefers-reduced-motion` it is a plain opacity fade with no movement, blur or parallax.
- **Login page** is the same Supabase flow as before (log in, sign up, forgot password), reduced to the essentials. With no
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` it says accounts are off and offers the workspace; it never fakes a login. The
  "Continue with Google" button is still in the code but hidden; move it out of the `display:none` wrapper in `#stage-auth` to show it.
- **Palette** is warm walnut (`#211A16`) with cream text and a muted mustard accent (`#C99A32`), set once in the `:root`
  design tokens at the top of `index.html`, so the app and the landing page share it.
- **Media states.** A video whose container has no audio track is reported as **NO AUDIO TRACK** (and is not uploaded), an
  empty or unreadable file as **INVALID MEDIA**, and a real audio track with no speech still as **No speech detected**.
  Detection reads only the MP4/MOV or WebM/Matroska header (`probeMediaTracks`) and fails open: if it cannot be sure, the
  file goes through the normal pipeline exactly as before.
