// api/blob-upload.js
//
// Vercel Blob client-upload token handshake.
// The browser uploads the actual file directly to Vercel Blob.
//
// IMPORTANT:
// This project uses the active Blob store token:
// BLOB_1_READ_WRITE_TOKEN

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
    return jsonResponse(
      { error: 'Invalid JSON body.' },
      { status: 400 }
    );
  }

  try {
    const result = await handleUpload({
      body,
      request,

      // IMPORTANT:
      // Use the active Vercel Blob store token.
      token: process.env.BLOB_1_READ_WRITE_TOKEN,

      onBeforeGenerateToken: async () => {
        return {
          allowedContentTypes: [
            // Audio
            'audio/webm',
            'audio/webm;codecs=opus',
            'audio/ogg',
            'audio/ogg;codecs=opus',
            'audio/wav',
            'audio/x-wav',
            'audio/mpeg',
            'audio/mp3',
            'audio/mp4',
            'audio/x-m4a',
            'audio/aac',

            // Video
            'video/mp4',
            'video/webm',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp9,opus',
            'video/quicktime',
          ],

          // Keep the existing 200 MB upload limit.
          maximumSizeInBytes: 200 * 1024 * 1024,

          // Give each upload a unique filename.
          addRandomSuffix: true,
        };
      },

      onUploadCompleted: async ({ blob }) => {
        console.log(
          'Blob upload completed:',
          blob.url
        );
      },
    });

    return jsonResponse(result);

  } catch (err) {
    const msg = err?.message || '';

    if (/private/i.test(msg) || /access/i.test(msg)) {
      return jsonResponse(
        {
          error:
            `Could not authorize this upload (${msg}). ` +
            `Make sure the BLOB_1_READ_WRITE_TOKEN belongs to the ` +
            `active Vercel Blob store and that the store configuration ` +
            `matches the application's public-upload flow.`,
        },
        { status: 400 }
      );
    }

    return jsonResponse(
      {
        error:
          msg ||
          'Could not generate a Vercel Blob upload token.',
      },
      { status: 400 }
    );
  }
}
