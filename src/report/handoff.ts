/**
 * Getting the report out of the application.
 *
 * Correction never happens here: the sophrologist copies the report into
 * Google Docs or Notion and edits her terpnos logos there, or saves it as a
 * file beside the session. There is deliberately no integration with either
 * editor — a clipboard and a file survive a migration between them.
 */

/**
 * The report's own styles, spelled out on the elements that carry them. A
 * stylesheet does not travel with a paste: Google Docs and Notion read the
 * pasted markup and drop anything a `<style>` block would have said, so the
 * red, the strike-through and the grey italic ride on the elements instead.
 */
const INLINE_STYLES: Record<string, string> = {
  addition: "color:#c0392b;font-weight:700;",
  omission: "color:#c0392b;font-weight:700;text-decoration:line-through;",
  "non-spoken":
    "color:#8b8378;font-style:italic;font-weight:400;text-decoration:none;",
};

/** What holds the pasted report together: the pacing of the terpnos logos. */
// Single quotes around the font name on purpose: this whole declaration sits
// inside a double-quoted attribute, and a double quote here would close it.
const DOCUMENT_STYLE =
  "white-space:pre-wrap;color:#1f1b16;" +
  "font-family:Georgia,'Times New Roman',serif;";

/** The report as the clipboard carries it: formatted, and plain. */
export type ReportFlavours = { html: string; text: string };

export function reportFlavours(report: string): ReportFlavours {
  const parsed = new DOMParser().parseFromString(report, "text/html");
  const content =
    parsed.querySelector<HTMLElement>(".terpnos-logos") ?? parsed.body;

  for (const marked of content.querySelectorAll<HTMLElement>("[class]")) {
    const style = INLINE_STYLES[marked.className];

    if (style) marked.setAttribute("style", style);
  }

  // Taken before the line breaks become markup, so the plain flavour keeps the
  // paragraphs and line breaks of the terpnos logos as newlines.
  const text = content.textContent ?? "";

  breakLines(content, parsed);

  return {
    html: `<div style="${DOCUMENT_STYLE}">${content.innerHTML}</div>`,
    text,
  };
}

/**
 * One click, one clipboard item, both flavours: a single paste lands in Google
 * Docs or Notion with its colours, and anywhere else as text.
 */
export async function copyReport(report: string): Promise<void> {
  const { html, text } = reportFlavours(report);

  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    }),
  ]);
}

/** The name the report takes on disk, so it can be filed with the session. */
export function reportFileName(day: Date = new Date()): string {
  const date = [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  ].join("-");

  return `rapport-de-seance-${date}.html`;
}

/**
 * The report saved as it stands. It is already a document of its own with its
 * styles embedded, so what lands on disk is the very string the page shows,
 * and it opens on its own exactly as it reads here.
 */
export function downloadReport(report: string): void {
  const address = URL.createObjectURL(
    new Blob([report], { type: "text/html;charset=utf-8" }),
  );
  const link = document.createElement("a");

  link.href = address;
  link.download = reportFileName();
  link.click();

  // Released once the browser has taken the download, never before it.
  setTimeout(() => URL.revokeObjectURL(address), 0);
}

/**
 * The line breaks of the terpnos logos, as markup. A document editor reading a
 * paste breaks lines where the markup says to, not where the text does.
 */
function breakLines(root: HTMLElement, owner: Document): void {
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];

  while (walker.nextNode()) texts.push(walker.currentNode as Text);

  for (const node of texts) {
    if (!node.data.includes("\n")) continue;

    const broken = owner.createDocumentFragment();

    node.data.split("\n").forEach((line, index) => {
      if (index > 0) broken.appendChild(owner.createElement("br"));
      if (line) broken.appendChild(owner.createTextNode(line));
    });

    node.replaceWith(broken);
  }
}
