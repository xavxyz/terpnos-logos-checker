import {
  acceptedRecordingFormats,
  type AcceptedRecordingFormat,
} from "./accepted-formats";

/**
 * Every recording is uploaded under this folder, and nothing else ever is. The
 * upload token and the deletion route both refuse a pathname outside it, so
 * neither can be turned against another part of the store.
 */
export const recordingsFolder = "enregistrements/";

/**
 * Generous enough for a 40-minute session in uncompressed wav, and low enough
 * that a token cannot be spent on something that is not a recording.
 */
export const maximumRecordingSizeInBytes = 700 * 1024 * 1024;

/**
 * How long the upload token stays usable. A 40-minute recording is a large file
 * and a slow uplink takes a while, so the window is an hour — long enough for
 * one upload, short enough that a leaked token dies on its own.
 */
export const uploadTokenValidityInMilliseconds = 60 * 60 * 1000;

const recordingPathnamePattern = new RegExp(
  `^${recordingsFolder}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(${acceptedRecordingFormats
    .map((format) => `\\${format}`)
    .join("|")})$`,
);

/**
 * Where this recording will live for the length of the flow. The name is random
 * and used once: the token the server issues is bound to it, overwriting is
 * refused, and the blob is deleted before the flow ends.
 */
export function recordingPathname(format: AcceptedRecordingFormat): string {
  return `${recordingsFolder}${globalThis.crypto.randomUUID()}${format}`;
}

export function isRecordingPathname(pathname: string): boolean {
  return recordingPathnamePattern.test(pathname);
}

/** Where the browser asks the server for the token for one upload. */
export const uploadTokenRoute = "/api/enregistrement/televersement";

/** Where the browser tells the server the flow is over and the blob can go. */
export const recordingDeletionRoute = "/api/enregistrement/suppression";
