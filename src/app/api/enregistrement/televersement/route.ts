import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { hasRememberedSession } from "@/auth/session";
import { deleteAbandonedRecordings } from "@/recording/blob-store";
import {
  isRecordingPathname,
  maximumRecordingSizeInBytes,
  uploadTokenValidityInMilliseconds,
} from "@/recording/blob-upload";
import { acceptedRecordingContentTypes } from "@/recording/accepted-formats";

/**
 * Issues the token the browser uses to upload the recording straight to Vercel
 * Blob. A Vercel function caps its request body at 4.5 MB and a 40-minute
 * session is far past that, so the audio never travels through here: only this
 * token does.
 *
 * The token is minted by the server, for one pathname, for one hour, and the
 * store refuses to overwrite an existing blob — so it buys exactly one upload
 * of exactly this recording and nothing else.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!(await hasRememberedSession())) {
    return NextResponse.json(
      { erreur: "Session expirée : entrez à nouveau le mot de passe." },
      { status: 401 },
    );
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const issued = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!isRecordingPathname(pathname)) {
          throw new Error(`Not a recording pathname: ${pathname}`);
        }

        await sweepAbandonedRecordings();

        return {
          allowedContentTypes: [...acceptedRecordingContentTypes],
          maximumSizeInBytes: maximumRecordingSizeInBytes,
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: Date.now() + uploadTokenValidityInMilliseconds,
          tokenPayload: null,
        };
      },
    });

    return NextResponse.json(issued);
  } catch (error) {
    return NextResponse.json(
      {
        erreur: "L’autorisation d’envoi a été refusée.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
}

/**
 * A recording left behind by a flow that died without warning still costs
 * money, so every new upload takes the opportunity to clear the old ones. A
 * failed sweep must never stop the sophrologist from sending her session.
 */
async function sweepAbandonedRecordings(): Promise<void> {
  try {
    await deleteAbandonedRecordings();
  } catch {
    // Deliberately ignored: the next upload will try again.
  }
}
