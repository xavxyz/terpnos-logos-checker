import { diff, type DiffOp } from "./diff";
import {
  tokeniseScript,
  tokeniseTranscript,
  type SpokenToken,
  type WrittenWord,
} from "./tokenise";

export type Transcript = {
  words: readonly { text: string; start: number }[];
};

export type ReportInput = {
  /** The terpnos logos, exactly as the sophrologist wrote it. */
  script: string;
  transcript: Transcript;
};

const STYLES = `
  body {
    margin: 0;
    padding: 2rem 1.5rem;
    background: #fdfcfa;
    color: #1f1b16;
    font: 1.05rem/1.7 Georgia, "Times New Roman", serif;
  }
  .terpnos-logos {
    margin: 0 auto;
    max-width: 42rem;
    white-space: pre-wrap;
  }
  .addition,
  .omission {
    color: #c0392b;
    font-weight: 700;
  }
  .omission {
    text-decoration: line-through;
  }
  [data-start] {
    cursor: pointer;
  }
`;

/**
 * The report: the terpnos logos as written, with every difference marked
 * inside it. Built on the terpnos logos and never on the transcript, so the
 * author's own paragraphs, line breaks and punctuation survive.
 */
export function buildReport({ script, transcript }: ReportInput): string {
  const written = tokeniseScript(script);
  const spoken = tokeniseTranscript(transcript.words);
  const ops = diff(
    written.map((word) => word.normalised),
    spoken.map((token) => token.normalised),
  );

  return document(render({ script, written, spoken, ops }));
}

type RenderInput = {
  script: string;
  written: WrittenWord[];
  spoken: SpokenToken[];
  ops: DiffOp[];
};

function render({ script, written, spoken, ops }: RenderInput): string {
  const out: string[] = [];
  let cursor = 0;
  /** Where the recording stands, so a difference can seek the player. */
  let lastSpokenStart: number | null = null;
  let anyWordWritten = false;

  const gapBefore = (word: WrittenWord) => {
    out.push(escape(script.slice(cursor, word.from)));
  };

  for (const run of runs(ops)) {
    if (run[0].kind === "equal") {
      for (const op of run as Extract<DiffOp, { kind: "equal" }>[]) {
        const word = written[op.left];
        gapBefore(word);
        out.push(escape(script.slice(word.from, word.to)));
        cursor = word.to;
        lastSpokenStart = spoken[op.right].start;
        anyWordWritten = true;
      }
      continue;
    }

    if (run[0].kind === "omission") {
      const omitted = (run as Extract<DiffOp, { kind: "omission" }>[]).map(
        (op) => written[op.left],
      );
      // A block never spans a line break: the structure of the document stays
      // readable, and each line keeps its own strike-through.
      for (const block of splitOnLineBreaks(omitted, script)) {
        const first = block[0];
        const last = block[block.length - 1];
        gapBefore(first);
        out.push(
          span(
            "omission",
            lastSpokenStart,
            escape(script.slice(first.from, last.to)),
          ),
        );
        cursor = last.to;
        anyWordWritten = true;
      }
      continue;
    }

    const added = (run as Extract<DiffOp, { kind: "addition" }>[]).map(
      (op) => spoken[op.right],
    );
    // Punctuation closing the previous written word stays attached to it; the
    // addition goes after it, and before any line break that follows.
    const attached = anyWordWritten
      ? (/^[^\s\p{L}\p{N}]*/u.exec(script.slice(cursor))?.[0] ?? "")
      : "";
    out.push(escape(attached));
    cursor += attached.length;

    const heard = span("addition", added[0].start, escape(spokenText(added)));
    // The addition sits between two written words; a space keeps it apart.
    out.push(anyWordWritten ? ` ${heard}` : `${heard} `);
    lastSpokenStart = added[added.length - 1].start;
  }

  out.push(escape(script.slice(cursor)));
  return out.join("");
}

/** Consecutive operations of one kind: one difference, not a scatter of words. */
function runs(ops: DiffOp[]): DiffOp[][] {
  const grouped: DiffOp[][] = [];
  for (const op of ops) {
    const last = grouped[grouped.length - 1];
    if (last && last[0].kind === op.kind) last.push(op);
    else grouped.push([op]);
  }
  return grouped;
}

function splitOnLineBreaks(
  omitted: WrittenWord[],
  script: string,
): WrittenWord[][] {
  const blocks: WrittenWord[][] = [];
  for (const word of omitted) {
    const block = blocks[blocks.length - 1];
    const previous = block?.[block.length - 1];
    if (
      block &&
      previous &&
      !script.slice(previous.to, word.from).includes("\n")
    ) {
      block.push(word);
    } else {
      blocks.push([word]);
    }
  }
  return blocks;
}

/** What the transcription heard, one entry per spoken word. */
function spokenText(tokens: SpokenToken[]): string {
  const said: string[] = [];
  let previousIndex = -1;
  for (const token of tokens) {
    if (token.spokenIndex === previousIndex) continue;
    said.push(token.display);
    previousIndex = token.spokenIndex;
  }
  return said.join(" ");
}

function span(
  kind: "addition" | "omission",
  start: number | null,
  content: string,
): string {
  const moment = start === null ? "" : ` data-start="${Math.round(start)}"`;
  return `<span class="${kind}"${moment}>${content}</span>`;
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function document(body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rapport de séance</title>
<style>${STYLES}</style>
</head>
<body>
<article class="terpnos-logos">${body}</article>
</body>
</html>
`;
}
