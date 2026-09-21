// api/blob-upload.js
//
// This route does NOT receive the audio file itself. It's the token
// handshake for @vercel/blob's client-upload flow: the browser calls
// upload() from '@vercel/blob/client', which POSTs here twice —
// once to get a short-lived upload token (onBeforeGenerateToken) and,
// once deployed, once more when the upload finishes (onUploadCompleted).
// The actual file bytes go straight from the browser to Blob storage,
// never through this (or any) Vercel Function, so there's no payload-size
// limit on the recording itself.
//
// Requires BLOB_READ_WRITE_TOKEN, which Vercel injects automatically once
// you create a Blob store and connect it to this project (Storage tab).

import { handleUpload } from '@vercel/blob/client';
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

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        // No auth gate here since this is a single-user local-storage
        // prototype. If you add real user accounts, verify the caller
        // here before returning a token.
        return {
          // MediaRecorder's real default mimeType includes a codecs
          // parameter (e.g. 'audio/webm;codecs=opus'), which is a
          // DIFFERENT string from the bare 'audio/webm'. Vercel Blob
          // matches allowedContentTypes by prefix, so listing both the
          // bare type and common codec-qualified variants — plus the
          // frontend normalizing to the bare type before upload (see
          // index.html) — makes this robust against browser differences
          // instead of silently rejecting the upload.
          allowedContentTypes: [
            'audio/webm', 'audio/webm;codecs=opus',
            'audio/ogg', 'audio/ogg;codecs=opus',
            'audio/wav', 'audio/x-wav',
            'audio/mpeg', 'audio/mp3',
            'audio/mp4', 'audio/x-m4a', 'audio/aac',
            'video/mp4', 'video/webm', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/quicktime',
          ],
          addRandomSuffix: true,
          maximumSizeInBytes: 200 * 1024 * 1024, // 200MB
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // Fires only on a real deployment (Blob calls this URL back over
        // the internet) — never during local `vercel dev`. Nothing to do
        // here since the frontend already gets the blob URL directly from
        // upload()'s return value and calls /api/transcribe itself.
        console.log('Blob upload completed:', blob.url);
      },
    });

    return jsonResponse(result);
  } catch (err) {
    const msg = err.message || '';
    if (/private/i.test(msg) || /access/i.test(msg)) {
      return jsonResponse({ error: `Could not authorize this upload (${msg}). This app uploads with access:'public' — if the connected Blob store was created as PRIVATE, that mismatch is almost certainly the cause. Create a Blob store with PUBLIC access in the Vercel dashboard and connect that one instead; an existing store's access mode can't be changed after creation.` }, { status: 400 });
    }
    return jsonResponse({ error: msg || 'Could not generate an upload token.' }, { status: 400 });
  }
}
