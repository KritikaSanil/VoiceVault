import { handleUpload } from '@vercel/blob/client';
import { jsonResponse, preflight } from '../lib/cors.js';

export async function OPTIONS(request) {
  return preflight(request);
}

export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse(
      { error: 'Invalid JSON body.' },
      { status: 400 }
    );
  }

  try {
    const result = await handleUpload({
      body,
      request,

      // Use the NEW public VoiceVault Blob store
      token: process.env.BLOB_1_READ_WRITE_TOKEN,

      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
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
          'video/mp4',
          'video/webm',
          'video/webm;codecs=vp8,opus',
          'video/webm;codecs=vp9,opus',
          'video/quicktime'
        ],
        addRandomSuffix: true,
        maximumSizeInBytes: 200 * 1024 * 1024
      }),

      onUploadCompleted: async ({ blob }) => {
        console.log('Blob upload completed:', blob.url);
      }
    });

    return jsonResponse(result);

  } catch (error) {
    console.error('Blob upload error:', error);

    const message = error?.message || '';

    if (/private/i.test(message) || /access/i.test(message)) {
      return jsonResponse(
        {
          error:
            `Could not authorize this upload (${message}). ` +
            `Make sure the connected Blob store is PUBLIC.`
        },
        { status: 400 }
      );
    }

    return jsonResponse(
      {
        error: message || 'Could not generate an upload token.'
      },
      { status: 400 }
    );
  }
}
