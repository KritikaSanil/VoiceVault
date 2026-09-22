// api/blob-upload.js
//
// This route does NOT receive audio. It's the token handshake for @vercel/blob's client-upload flow:
// the browser calls upload() from '@vercel/blob/client', which POSTs here to get a short-lived upload token
// (and, once deployed, once more when the upload finishes). The bytes go straight from the browser to Blob
// storage, never through a Vercel Function.
//
// The browser uploads small, prepared audio chunks (16 kHz mono WAV), or - only if the browser cannot decode a
// file and it is small enough - the original audio file. It does not upload videos.
//
// Token: the Blob store connected to this project may use a custom env prefix. This project's active variable is
// BLOB_1_READ_WRITE_TOKEN, and @vercel/blob only reads BLOB_READ_WRITE_TOKEN by default, so the token is resolved
// here and passed explicitly. (BLOB_READ_WRITE_TOKEN is still accepted as a fallback.)

import { handleUpload } from '@vercel/blob/client';
import { jsonResponse, preflight } from '../lib/cors.js';

const blobToken = () => process.env.BLOB_1_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || undefined;

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

  const token = blobToken();
  if (!token) {
    return jsonResponse({
      error: 'Blob storage is not configured on the server. Connect a Blob store to this project so BLOB_1_READ_WRITE_TOKEN (or BLOB_READ_WRITE_TOKEN) is set, then redeploy.',
      code: 'not_configured',
    }, { status: 500 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      token,
      onBeforeGenerateToken: async () => {
        // No auth gate here since this is a single-user local-storage prototype. If you add real user
        // accounts, verify the caller here before returning a token.
        return {
          // Vercel Blob matches allowedContentTypes by prefix; MediaRecorder types often carry a codecs parameter.
          allowedContentTypes: [
            'audio/wav', 'audio/x-wav', 'audio/wave',
            'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
            'audio/ogg', 'audio/ogg;codecs=opus', 'audio/opus',
            'audio/webm', 'audio/webm;codecs=opus',
            'audio/flac', 'audio/x-flac',
            'video/mp4', 'video/webm', 'video/quicktime',
          ],
          addRandomSuffix: true,
          maximumSizeInBytes: 30 * 1024 * 1024, // chunks are ~10MB; the direct-upload fallback is capped at Groq's 25MB
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // Fires only on a real deployment. Nothing to do: the browser already has the URL.
        console.log('Blob upload completed');
      },
    });

    return jsonResponse(result);
  } catch (err) {
    const msg = err.message || '';
    if (/private/i.test(msg) || /access/i.test(msg)) {
      return jsonResponse({ error: `Could not authorize this upload (${msg}). This app uploads with access:'public' - if the connected Blob store was created as PRIVATE, that mismatch is almost certainly the cause. Create a Blob store with PUBLIC access in the Vercel dashboard and connect that one instead; an existing store's access mode can't be changed after creation.` }, { status: 400 });
    }
    return jsonResponse({ error: msg || 'Could not generate an upload token.' }, { status: 400 });
  }
}
