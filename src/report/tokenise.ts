import { normalise } from "./normalise";

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** A word of the terpnos logos, kept in place so the report can rebuild it. */
export type WrittenWord = {
  normalised: string;
  /** Offsets in the terpnos logos, so gaps are rendered exactly as written. */
  from: number;
  to: number;
};

/** A word of the transcript, with the moment it was spoken. */
export type SpokenToken = {
  normalised: string;
  /** What the transcription heard, punctuation included, shown as-is. */
  display: string;
  start: number;
  /** Which transcript word this came from; a compound word yields several. */
  spokenIndex: number;
};

export function tokeniseScript(script: string): WrittenWord[] {
  const words: WrittenWord[] = [];
  for (const match of script.matchAll(WORD)) {
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
  words: readonly { text: string; start: number }[],
): SpokenToken[] {
  const tokens: SpokenToken[] = [];
  words.forEach((word, spokenIndex) => {
    for (const match of word.text.matchAll(WORD)) {
      const normalised = normalise(match[0]);
      if (!normalised) continue;
      tokens.push({
        normalised,
        display: word.text,
        start: word.start,
        spokenIndex,
      });
    }
  });
  return tokens;
}
