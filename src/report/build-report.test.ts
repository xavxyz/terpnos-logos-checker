import { describe, expect, it } from "vitest";

import { buildReport } from "./build-report";

type SpokenWord = { text: string; start: number };

const spoken = (sentence: string, from = 0, step = 500): SpokenWord[] =>
  sentence
    .split(/\s+/)
    .filter(Boolean)
    .map((text, index) => ({ text, start: from + index * step }));

/** The report is HTML; these helpers read it the way the sophrologist would. */
const marked = (html: string, kind: "addition" | "omission") =>
  [
    ...html.matchAll(
      new RegExp(`<span class="${kind}"[^>]*>(.*?)</span>`, "gs"),
    ),
  ].map((match) => match[1]);

const startsOf = (html: string, kind: "addition" | "omission") =>
  [
    ...html.matchAll(
      new RegExp(`<span class="${kind}" data-start="(\\d+)"`, "g"),
    ),
  ].map((match) => Number(match[1]));

const nonSpoken = (html: string) =>
  [...html.matchAll(/<span class="non-spoken">(.*?)<\/span>/gs)].map(
    (match) => match[1],
  );

const styleRuleFor = (html: string, selector: string) =>
  new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(html)?.[1] ?? "";

const plainText = (html: string) =>
  html
    .slice(html.indexOf("<body>"))
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&");

describe("buildReport", () => {
  it("returns a self-contained HTML document with embedded CSS", () => {
    const html = buildReport({
      script: "Fermez les yeux.",
      transcript: { words: spoken("Fermez les yeux.") },
    });

    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<style>");
    expect(html).toContain("</html>");
    expect(html).not.toMatch(/<link|<script/);
  });

  it("renders the terpnos logos as written when the reading is faithful", () => {
    const script = "Fermez les yeux.\n\nRespirez lentement.";
    const html = buildReport({
      script,
      transcript: { words: spoken("Fermez les yeux. Respirez lentement.") },
    });

    expect(plainText(html)).toContain(script);
    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([]);
  });

  it("preserves paragraphs, line breaks and punctuation of the terpnos logos", () => {
    const script = "Fermez les yeux,\ndoucement.\n\nPuis respirez : lentement.";
    const html = buildReport({
      script,
      transcript: {
        words: spoken("Fermez les yeux doucement Puis respirez lentement"),
      },
    });

    expect(plainText(html)).toContain(script);
  });

  it("marks a word said but not written as an addition", () => {
    const html = buildReport({
      script: "Fermez les yeux.",
      transcript: {
        words: [
          { text: "Fermez", start: 1000 },
          { text: "doucement", start: 1500 },
          { text: "les", start: 2000 },
          { text: "yeux.", start: 2500 },
        ],
      },
    });

    expect(marked(html, "addition")).toEqual(["doucement"]);
    expect(marked(html, "omission")).toEqual([]);
    expect(plainText(html)).toContain("Fermez doucement les yeux.");
  });

  it("marks a word written but not said as an omission", () => {
    const html = buildReport({
      script: "Fermez doucement les yeux.",
      transcript: {
        words: [
          { text: "Fermez", start: 1000 },
          { text: "les", start: 2000 },
          { text: "yeux.", start: 2500 },
        ],
      },
    });

    expect(marked(html, "omission")).toEqual(["doucement"]);
    expect(marked(html, "addition")).toEqual([]);
    expect(plainText(html)).toContain("Fermez doucement les yeux.");
  });

  it("keeps a repeated sentence as one continuous addition", () => {
    const script = "Fermez les yeux. Respirez lentement.";
    const html = buildReport({
      script,
      transcript: {
        words: spoken(
          "Fermez les yeux. Fermez les yeux. Respirez lentement.",
          1000,
        ),
      },
    });

    expect(marked(html, "addition")).toEqual(["Fermez les yeux."]);
  });

  it("keeps a skipped passage as one continuous omission", () => {
    const script = "Fermez les yeux. Respirez lentement. Détendez vos épaules.";
    const html = buildReport({
      script,
      transcript: { words: spoken("Fermez les yeux. Détendez vos épaules.") },
    });

    expect(marked(html, "omission")).toEqual(["Respirez lentement"]);
    expect(plainText(html)).toContain(script);
  });

  it("reports no difference between a spelled-out number and a digit", () => {
    const html = buildReport({
      script: "Comptez trois respirations, puis cinq.",
      transcript: { words: spoken("Comptez 3 respirations, puis 5.") },
    });

    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([]);
    expect(plainText(html)).toContain("Comptez trois respirations, puis cinq.");
  });

  it("reports no difference between a digit and a spelled-out number", () => {
    const html = buildReport({
      script: "Comptez jusqu'à 10.",
      transcript: { words: spoken("Comptez jusqu'à dix.") },
    });

    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([]);
  });

  it("reports no difference over accents, capitals, punctuation or apostrophes", () => {
    const html = buildReport({
      script: "Détendez l'épaule droite, doucement.",
      transcript: { words: spoken("detendez lepaule DROITE doucement") },
    });

    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([]);
    expect(plainText(html)).toContain("Détendez l'épaule droite, doucement.");
  });

  it("reports no difference over a hyphen in a compound word", () => {
    const html = buildReport({
      script: "Observez les micro-mouvements, peut-être.",
      transcript: {
        words: spoken("Observez les micro mouvements, peut être."),
      },
    });

    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([]);
    expect(plainText(html)).toContain(
      "Observez les micro-mouvements, peut-être.",
    );
  });

  it("reports no difference when the transcription joins a compound word", () => {
    const html = buildReport({
      script: "Observez les micro mouvements. Concentrez vous.",
      transcript: {
        words: spoken("Observez les micro-mouvements. Concentrez-vous."),
      },
    });

    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([]);
  });

  it("reports no difference over the oe ligature", () => {
    const html = buildReport({
      script: "Posez la main sur le coeur, le cœur bat.",
      transcript: { words: spoken("Posez la main sur le cœur, le coeur bat.") },
    });

    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([]);
    expect(plainText(html)).toContain("le coeur, le cœur bat.");
  });

  it("keeps the punctuation that follows an omitted passage", () => {
    const script = "Fermez les yeux, lentement, puis respirez.";
    const html = buildReport({
      script,
      transcript: { words: spoken("Fermez les yeux, puis respirez.") },
    });

    expect(marked(html, "omission")).toEqual(["lentement"]);
    expect(plainText(html)).toContain(script);
  });

  it("surfaces hesitations as additions", () => {
    const html = buildReport({
      script: "Fermez les yeux.",
      transcript: {
        words: [
          { text: "Fermez", start: 0 },
          { text: "euh", start: 400 },
          { text: "hum", start: 800 },
          { text: "les", start: 1200 },
          { text: "yeux.", start: 1600 },
        ],
      },
    });

    expect(marked(html, "addition")).toEqual(["euh hum"]);
  });

  it("gives an addition the moment of its first spoken word", () => {
    const html = buildReport({
      script: "Fermez les yeux.",
      transcript: {
        words: [
          { text: "Fermez", start: 1000 },
          { text: "euh", start: 1400 },
          { text: "hum", start: 1800 },
          { text: "les", start: 2200 },
          { text: "yeux.", start: 2600 },
        ],
      },
    });

    expect(startsOf(html, "addition")).toEqual([1400]);
  });

  it("gives an omission the moment of the last word actually spoken before it", () => {
    const html = buildReport({
      script: "Fermez les yeux doucement maintenant.",
      transcript: {
        words: [
          { text: "Fermez", start: 1000 },
          { text: "les", start: 1400 },
          { text: "yeux", start: 1800 },
          { text: "maintenant.", start: 2200 },
        ],
      },
    });

    expect(marked(html, "omission")).toEqual(["doucement"]);
    expect(startsOf(html, "omission")).toEqual([1800]);
  });

  it("gives an omission before any spoken word the start of the recording", () => {
    const html = buildReport({
      script: "Doucement, fermez les yeux.",
      transcript: {
        words: [
          { text: "Fermez", start: 1000 },
          { text: "les", start: 1400 },
          { text: "yeux.", start: 1800 },
        ],
      },
    });

    expect(marked(html, "omission")).toEqual(["Doucement"]);
    expect(startsOf(html, "omission")).toEqual([0]);
  });

  it("never prints a timecode as text", () => {
    const html = buildReport({
      script: "Fermez les yeux doucement.",
      transcript: { words: [{ text: "Fermez", start: 1000 }] },
    });

    expect(plainText(html)).not.toMatch(/1000|00:0/);
  });

  it("renders the whole terpnos logos as omitted when nothing was recorded", () => {
    const script = "Fermez les yeux.\n\nRespirez lentement.";
    const html = buildReport({ script, transcript: { words: [] } });

    expect(marked(html, "addition")).toEqual([]);
    expect(marked(html, "omission")).toEqual([
      "Fermez les yeux.\n\nRespirez lentement",
    ]);
    expect(plainText(html)).toContain(script);
  });

  it("never reports bracketed content as an omission", () => {
    const script =
      "[Séance du 3 mars — SDN]\n\nFermez les yeux.\n\n[Désophronisation]\n\nÉtirez-vous.";
    const html = buildReport({
      script,
      transcript: { words: spoken("Fermez les yeux. Étirez-vous.") },
    });

    expect(marked(html, "omission")).toEqual([]);
    expect(marked(html, "addition")).toEqual([]);
    expect(plainText(html)).toContain(script);
  });

  it("renders bracketed content as non-spoken", () => {
    const html = buildReport({
      script: "[Désophronisation]\n\nÉtirez-vous.",
      transcript: { words: spoken("Étirez-vous.") },
    });

    expect(nonSpoken(html)).toEqual(["[Désophronisation]"]);
    expect(styleRuleFor(html, ".non-spoken")).toMatch(/font-style:\s*italic/);
    expect(styleRuleFor(html, ".non-spoken")).toMatch(/color:\s*#[0-9a-f]{6}/i);
  });

  it("keeps bracketed content out of a surrounding omission", () => {
    const script = "Respirez lentement.\n\n[SDN]\n\nDétendez vos épaules.";
    const html = buildReport({
      script,
      transcript: { words: spoken("Voilà.") },
    });

    expect(nonSpoken(html)).toEqual(["[SDN]"]);
    expect(marked(html, "omission")).toEqual([
      "Respirez lentement.",
      "Détendez vos épaules",
    ]);
    expect(plainText(html)).toContain(script);
  });

  it("does not let an unclosed bracket swallow the rest of the document", () => {
    const script = "Fermez les yeux [note à moi-même\n\nRespirez lentement.";
    const html = buildReport({
      script,
      transcript: { words: spoken("Fermez les yeux note à moi-même") },
    });

    expect(nonSpoken(html)).toEqual([]);
    expect(marked(html, "omission")).toEqual(["Respirez lentement"]);
    expect(plainText(html)).toContain(script);
  });

  it("does not let an unclosed bracket swallow a later heading", () => {
    const script = "Fermez [les yeux.\n\n[SDN]\n\nRespirez lentement.";
    const html = buildReport({
      script,
      transcript: { words: spoken("Fermez les yeux. Respirez lentement.") },
    });

    expect(nonSpoken(html)).toEqual(["[SDN]"]);
    expect(marked(html, "omission")).toEqual([]);
    expect(plainText(html)).toContain(script);
  });

  it("renders an empty terpnos logos without throwing", () => {
    expect(() =>
      buildReport({ script: "", transcript: { words: [] } }),
    ).not.toThrow();
  });

  it("shows no score, percentage or counter", () => {
    const html = buildReport({
      script: "Fermez les yeux doucement.",
      transcript: { words: spoken("Fermez les yeux vraiment.") },
    });

    expect(plainText(html)).not.toMatch(/%|score|fidélité|différences?\s*:/i);
  });

  it("compares a 2000-word session quickly", () => {
    const words = Array.from({ length: 2000 }, (_, index) => `mot${index}`);
    const script = words.join(" ");
    const heard = words.filter((_, index) => index % 200 !== 0);

    const startedAt = performance.now();
    const html = buildReport({
      script,
      transcript: {
        words: heard.map((text, index) => ({ text, start: index * 300 })),
      },
    });
    const elapsed = performance.now() - startedAt;

    expect(marked(html, "omission")).toHaveLength(10);
    expect(elapsed).toBeLessThan(500);
  });

  it("compares a 2000-word session against silence quickly", () => {
    const script = Array.from({ length: 2000 }, (_, i) => `mot${i}`).join(" ");

    const startedAt = performance.now();
    const html = buildReport({ script, transcript: { words: [] } });
    const elapsed = performance.now() - startedAt;

    expect(marked(html, "omission")).toHaveLength(1);
    expect(elapsed).toBeLessThan(500);
  });
});
