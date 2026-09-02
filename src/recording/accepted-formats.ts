/**
 * The three formats the sophrologist's production chain produces: m4a from the
 * recorder, wav after filtering, mp3 once compressed.
 */
export const acceptedRecordingFormats = [".mp3", ".m4a", ".wav"] as const;

/**
 * Browsers disagree on the media type of an m4a — and sometimes report none at
 * all — so the extension is what decides.
 */
export function isAcceptedRecording(file: {
  name: string;
  type: string;
}): boolean {
  const name = file.name.toLowerCase();

  return acceptedRecordingFormats.some((format) => name.endsWith(format));
}
