/**
 * Normalisation reduces two words to the form in which they count as the same
 * word. It exists solely to eliminate noise, and applies to the comparison
 * only: the report always displays the original text.
 */
export function normalise(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
