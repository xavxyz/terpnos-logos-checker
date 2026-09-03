/**
 * The three formats the sophrologist's production chain produces: m4a from the
 * recorder, wav after filtering, mp3 once compressed.
 */
export const acceptedRecordingFormats = [".mp3", ".m4a", ".wav"] as const;

export type AcceptedRecordingFormat = (typeof acceptedRecordingFormats)[number];

/**
 * Browsers disagree on the media type of an m4a — and sometimes report none at
 * all — so the extension is what decides.
 */
export function recordingFormat(
  fileName: string,
): AcceptedRecordingFormat | null {
  const name = fileName.toLowerCase();

  return (
    acceptedRecordingFormats.find((format) => name.endsWith(format)) ?? null
  );
}

export function isAcceptedRecording(file: {
  name: string;
  type: string;
}): boolean {
  return recordingFormat(file.name) !== null;
}

const contentTypeByFormat: Record<AcceptedRecordingFormat, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

/**
 * The media type the recording is announced with when it is uploaded. It is
 * derived from the extension rather than taken from the browser, so the upload
 * token can be scoped to exactly the three types this application accepts.
 */
export function recordingContentType(format: AcceptedRecordingFormat): string {
  return contentTypeByFormat[format];
}

export const acceptedRecordingContentTypes =
  acceptedRecordingFormats.map(recordingContentType);
