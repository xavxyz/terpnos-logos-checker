import { del, list } from "@vercel/blob";

import {
  isRecordingPathname,
  recordingsFolder,
  uploadTokenValidityInMilliseconds,
} from "./blob-upload";

/**
 * Vercel Blob bills a blob for as long as it exists and a session recording is
 * large, so nothing is ever left behind: the server deletes the recording as
 * soon as it is done with it, and equally when the flow fails or is abandoned.
 */
export async function deleteRecording(pathname: string): Promise<void> {
  if (!isRecordingPathname(pathname)) {
    throw new Error(`Not a recording pathname: ${pathname}`);
  }

  // Deleting a blob that never landed — an upload that failed on its first
  // part, a flow abandoned before any byte arrived — is a no-op, so the same
  // call covers the successful and the unhappy paths.
  await del(pathname);
}

/**
 * The last resort, for the flow that died without ever asking for its blob to
 * be deleted: a browser killed mid-upload, a machine put to sleep. Anything
 * older than twice the life of an upload token cannot belong to a live upload,
 * so it is an orphan and it is deleted.
 */
export async function deleteAbandonedRecordings(): Promise<void> {
  const olderThan = Date.now() - 2 * uploadTokenValidityInMilliseconds;

  const { blobs } = await list({ prefix: recordingsFolder });
  const abandoned = blobs
    .filter((blob) => blob.uploadedAt.getTime() < olderThan)
    .map((blob) => blob.url);

  if (abandoned.length > 0) {
    await del(abandoned);
  }
}
