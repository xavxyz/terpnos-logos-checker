/**
 * The colours the report is written in, taken from the sophrologist's own site
 * so the report reads as hers wherever it lands.
 *
 * They live here as constants rather than in the stylesheet because the report
 * travels: it is built as a standalone document and pasted into Google Docs or
 * Notion, neither of which carries a `<style>` block or a custom property
 * across. `src/app/globals.css` mirrors these values for the surrounding page.
 */
export const reportPalette = {
  /** Deep purple: the text of the report, and of the site it comes from. */
  encre: "#492e76",
  /** Warm cream: the page the report is written on, as on the site. */
  fond: "#f6efe9",
  /** Coral, darkened until it carries text: every difference is marked in it. */
  difference: "#b94322",
  /** Muted purple: what is written but never meant to be spoken. */
  nonDit: "#6f6284",
} as const;
