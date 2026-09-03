/**
 * Small French numbers, as they read once accents and case are gone. The
 * transcription writes a digit where the terpnos logos spells the number out,
 * and that difference is noise: both sides are canonicalised to the digit.
 */
const SMALL_FRENCH_NUMBERS: Record<string, string> = {
  zero: "0",
  un: "1",
  une: "1",
  deux: "2",
  trois: "3",
  quatre: "4",
  cinq: "5",
  six: "6",
  sept: "7",
  huit: "8",
  neuf: "9",
  dix: "10",
  onze: "11",
  douze: "12",
  treize: "13",
  quatorze: "14",
  quinze: "15",
  seize: "16",
  vingt: "20",
  trente: "30",
  quarante: "40",
  cinquante: "50",
  soixante: "60",
  cent: "100",
  mille: "1000",
};

/**
 * Normalisation reduces two words to the form in which they count as the same
 * word. It exists solely to eliminate noise, and applies to the comparison
 * only: the report always displays the original text.
 *
 * Lowercase, ligatures expanded, accents stripped, punctuation and apostrophes
 * removed, small French numbers canonicalised.
 */
export function normalise(word: string): string {
  const bare = word
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]/g, "");

  return SMALL_FRENCH_NUMBERS[bare] ?? bare;
}
