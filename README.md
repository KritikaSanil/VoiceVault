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


## Transcription reliability, Original/Clean, vertical library, and VOICE -> AUDIO -> WORDS -> KNOWLEDGE

**Transcription (`api/transcribe.js`, `api/blob-upload.js`, `api/health.js`, and the client pipeline in `index.html`):**
- Default model is `whisper-large-v3` (accuracy over speed), overridable with `GROQ_WHISPER_MODEL`. `temperature: 0`,
  `response_format: "verbose_json"`, segment timestamps, optional word-level timestamps.
- Audio is decoded in the browser (mono, 16 kHz WAV) for every format the browser can play, including a video's own
  audio track; only that small WAV chunk is ever uploaded and sent to Groq, never the video file itself. A handful of
  formats this browser can't decode (e.g. some `.m4a`/`.mp4` AAC) fall back to uploading the original file directly, if
  it's small enough and Groq accepts that container natively.
- Long media is split into 5-minute chunks with 5-second overlaps; the overlap is textually matched and de-duplicated
  on merge, and timestamps stay on the *original* timeline (never reset per chunk) — verified against synthetic
  ground-truth audio with word-for-word accuracy and ~0.02s timestamp error.
- Language: Auto / English / Hindi / Marathi, sent as the correct ISO-639-1 code; Auto sends no `language` parameter
  so Whisper detects it. Optional context/terminology prompt is forwarded verbatim (capped at 700 chars), never invented.
- Multiple files process independently in a queue (one at a time), each with its own honest status; one failing never
  blocks the others.
- Four separate, honest states — NO AUDIO TRACK, NO SPEECH, TRANSCRIPTION FAILED, couldn't-read-file — verified against
  real ffmpeg-generated silent / speechless / audio-track-less / corrupt media, never inferred from one another.
- `BLOB_1_READ_WRITE_TOKEN` is read explicitly (with `BLOB_READ_WRITE_TOKEN` as a fallback), since the SDK's default only
  reads the latter. `GROQ_API_KEY` never appears in a response or a log line, even inside an error message.

**Original / Clean transcript toggle:** Clean is a deterministic, rule-based cleanup (filler-word removal, spacing,
punctuation, capitalisation) — no AI call, no invented words, so Original and Clean always share identical timestamps,
segment ids, and playback position. The choice is remembered per source. Search, Key Moments, and seeking all work
in both modes.

**Vertical library (real app):** the Library screen's Sources view is a single vertical list with thin dividers
instead of a 2-column card grid, with hover micro-interactions (subtle surface change, a tiny waveform reveal, 1-2px
lift). This was a CSS-only change; every existing handler (select, favorite, delete, filter, search, open) is untouched.

**Landing page:** the transcript ("Every word, searchable.") section's duplicate waveform was removed, so the hero's
waveform is the only one on the page. The hero now closes its reveal sequence with a small
"SEARCHABLE · TIMESTAMPED · ORGANIZED" line, completing a VOICE -> AUDIO -> WORDS -> KNOWLEDGE arc using the page's
existing elements (headline, waveform, live caption) rather than a new animation subsystem. A very subtle
architectural grid background (the exact rgba(226,204,174,0.035), 48px pattern) sits behind the hero and transcript
sections, and three small decorative 2x2/3x3 grid fragments (not buttons, not cards) pop in once near the hero, Key
Moments, and final CTA sections. Both the grid and the fragments are quieter on mobile (fragments hidden below 700px,
grid opacity roughly halved), and everything respects `prefers-reduced-motion`.

**Two pre-existing bugs found and fixed while working in this code**, confirmed present in the original,
unmodified project before any of this session's changes:
- A CSS specificity bug that silently prevented a hover effect from ever applying.
- `.shell` (the sidebar + main-content flex row) never switched to a column layout at the mobile breakpoint, so on
  narrow screens the sidebar and main content fought for space in the same row, causing real horizontal page overflow.


## Richer landing page, real Ask/search interactions, and Supabase schema

**Page rhythm expanded from 6 to 9 sections**, per the latest brief's explicit "fix the negative
space, add more premium content" direction (a reversal of an earlier "curate down" instruction --
the most recent brief wins): Hero, Every Word Searchable (now with a live search-results panel),
From Speech to Signal, Search the way you remember it, Find What Matters (now auto-cycling, no
click required) + Moments Not Minutes, Ask VoiceVault (now a real multi-question interaction with
follow-ups and a jumpable citation), Your Recordings (+ Resume Where You Left Off, + Recently
Found, richer hover-reveal rows), Everything Connected (a real flow diagram), and the final CTA
(renamed, two real entry-point buttons).

**Two real bugs found and fixed while building this:**
- A "KNOWLEDGE" resolution line and, later, a section heading were each nested inside another
  `.fl` (floating-reveal) element, so their independent scroll-parallax transform compounded with
  their parent's and visually detached them from their container, or in the heading's case, kept
  it at permanent zero opacity. Fixed both, then wrote an automated page-wide audit (checks every
  `.fl` element for a `.fl` ancestor, and every `.fl-h` for a missing base `.fl` class) that now
  passes clean -- kept as a regression guard.
- Clicking a citation or a semantic-search result set the transcript's manual timestamp, then
  called `scrollIntoView()` -- which fired the page's own scroll handler, which immediately reset
  that same manual override back to `null`, undoing the jump it had just made. Fixed with a short
  "jump hold" grace period (`trJumpTo()`) so a deliberate jump survives the scroll it triggers.

**Timestamp normalization:** the auto-cycling Find What Matters timeline reuses the same `mmss()`
formatter already used everywhere else on the page (floor-divide + pad), so 751 seconds always
renders as `12:31`, never `12:71` or similar -- verified by scanning every displayed timestamp on
the page, not just the new ones.

**Supabase:** `supabase/schema.sql` adds an optional Postgres schema (`profiles`, `recordings`,
`transcript_segments`, `key_moments`, `notes`) with Row Level Security restricting every table to
`auth.uid() = user_id`. **This SQL has been reviewed but not run against a live Supabase project**
-- there is no live project or credentials in this environment, so it is static verification only.
The app's actual data layer (IndexedDB + Blob) was deliberately left as-is rather than blind-wired
to this schema, since that would touch most of the app's existing, heavily-tested functionality
with no way to test the result for real; see the note at the end of `schema.sql` for the reasoning
and the recommended next step. Supabase **Auth** itself (sign up, log in, log out, forgot password,
persistent session) was already real in this project before this session and was re-verified, not
rebuilt: `getSession`, `onAuthStateChange`, `signUp`, `resetPasswordForEmail` are genuine Supabase
client calls with honest success/error messaging.

**Environment variables:** this project has no build step (no Vite, no bundler), so there is no
`import.meta.env` and therefore no `VITE_SUPABASE_URL`-style client-side variable to set. Instead,
`SUPABASE_URL` and `SUPABASE_ANON_KEY` are set as ordinary server-side Vercel environment variables
and handed to the browser at runtime through `GET /api/config`, which is the correct pattern for a
static-HTML-plus-serverless-functions app like this one -- the anon key is not a secret (it is
meant to be public; Row Level Security is what actually protects the data), but it still never
appears in the HTML/JS source, only in a response the page fetches after loading.


## Removed repetition, tightened spacing, added micro-interactions, dramatic final CTA

**Sections removed** (repeated the same "recordings become knowledge" idea): "From Speech to
Signal", the standalone "Search the way you remember it" section (its example now lives compactly
inside the Every Word Searchable results panel instead), "Moments, Not Minutes", and the "Your
recordings become knowledge" / Record-Transcribe-Find-Understand-Return list. The "Everything, in
one place" flow diagram was kept but its explanatory framing was dropped. Page went from 9 sections
/ 487 words to 7 sections / 397 words. "Your recordings" is a plain title again.

**A real bug found while removing content:** deleting the Moments-not-minutes markup left behind
JS that still tried to populate the now-missing element, throwing `Cannot set properties of null`
on every single page load. Caught by testing, not just by reading the diff, and fixed.

**Micro-interactions added:** buttons lift ~1.5px on hover and scale down on press; text links draw
an underline left-to-right on hover with a paired arrow shift; transcript timestamps brighten
distinctly on hover (separate from the line's own color change); the active transcript line now
gets a warm background tint and a mustard left-edge indicator bar, not just a text-color change.

**Spacing tightened** across Every Word Searchable, Find What Matters, Ask VoiceVault, Your
Recordings and Everything In One Place (reduced `padding-block` clamps).

**Final section rebuilt as a true ending:** "Your voice is worth remembering." at up to ~144px,
weight 600, centered and full-bleed, with just two real buttons and one small closing waveform
glyph (reused from the removed Speech-to-Signal section rather than adding a new visual). Confirmed
nothing follows it in the DOM.

**Testing:** 281+ tests across 13 suites, all passing after updating the handful with stale
expectations (section/word/element counts) left over from the removals -- those were mechanical
fixes, not behavioral ones. This remains static/mocked verification only: real client and server
code, with Groq/Blob/network calls mocked, and no live Supabase or Groq credentials in this
environment.
