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
      "Fermez les yeux",
      "Respirez lentement",
    ]);
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
    expect(elapsed).toBeLessThan(2000);
  });

  it("compares a 2000-word session against silence quickly", () => {
    const script = Array.from({ length: 2000 }, (_, i) => `mot${i}`).join(" ");

    const startedAt = performance.now();
    const html = buildReport({ script, transcript: { words: [] } });
    const elapsed = performance.now() - startedAt;

    expect(marked(html, "omission")).toHaveLength(1);
    expect(elapsed).toBeLessThan(2000);
  });
});
