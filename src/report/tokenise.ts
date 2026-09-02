import { normalise } from "./normalise";

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** One word of the transcript, carrying the moment it was spoken. */
export type SpokenWord = { text: string; start: number };

/** A word of the terpnos logos, kept in place so the report can rebuild it. */
export type WrittenWord = {
  normalised: string;
  /** Offsets in the terpnos logos, so gaps are rendered exactly as written. */
  from: number;
  to: number;
};

/** A word of the transcript, ready to be compared and displayed. */
export type TranscriptWord = {
  normalised: string;
  /** What the transcription heard, punctuation included, shown as-is. */
  display: string;
  start: number;
  /** Which transcript word this came from; a compound word yields several. */
  heardIndex: number;
};

export function tokeniseTerpnosLogos(terpnosLogos: string): WrittenWord[] {
  const words: WrittenWord[] = [];
  for (const match of terpnosLogos.matchAll(WORD)) {
    const normalised = normalise(match[0]);
    if (!normalised) continue;
    words.push({
      normalised,
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return words;
}

export function tokeniseTranscript(
  words: readonly SpokenWord[],
): TranscriptWord[] {
  const tokens: TranscriptWord[] = [];
  words.forEach((word, heardIndex) => {
    for (const match of word.text.matchAll(WORD)) {
      const normalised = normalise(match[0]);
      if (!normalised) continue;
      tokens.push({
        normalised,
        display: word.text,
        start: word.start,
        heardIndex,
      });
    }
  });
  return tokens;
}
