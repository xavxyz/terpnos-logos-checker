import { diff, type DiffOp } from "./diff";
import { nonSpokenRanges, segments, type TextRange } from "./non-spoken";
import {
  tokeniseTerpnosLogos,
  tokeniseTranscript,
  type SpokenWord,
  type TranscriptWord,
  type WrittenWord,
} from "./tokenise";

export type Transcript = { words: readonly SpokenWord[] };

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
  .non-spoken {
    color: #8b8378;
    font-style: italic;
    font-weight: 400;
    text-decoration: none;
  }
`;

/** The moment a difference points at when nothing has been spoken yet. */
const START_OF_RECORDING = 0;

/**
 * The report: the terpnos logos as written, with every difference marked
 * inside it. Built on the terpnos logos and never on the transcript, so the
 * author's own paragraphs, line breaks and punctuation survive.
 */
export function buildReport({ script, transcript }: ReportInput): string {
  const terpnosLogos = script;
  const nonSpoken = nonSpokenRanges(terpnosLogos);
  const written = tokeniseTerpnosLogos(terpnosLogos, nonSpoken);
  const heard = tokeniseTranscript(transcript.words);
  const ops = diff(
    written.map((word) => word.normalised),
    heard.map((word) => word.normalised),
  );

  return htmlDocument(render({ terpnosLogos, nonSpoken, written, heard, ops }));
}

type RenderInput = {
  terpnosLogos: string;
  nonSpoken: TextRange[];
  written: WrittenWord[];
  heard: TranscriptWord[];
  ops: DiffOp[];
};

function render({
  terpnosLogos,
  nonSpoken,
  written,
  heard,
  ops,
}: RenderInput): string {
  const out: string[] = [];
  let cursor = 0;
  /** Where the recording stands, so a difference can seek the player. */
  let lastSpokenStart = START_OF_RECORDING;
  let anythingRendered = false;

  /** The terpnos logos as written, non-spoken content marked as such. */
  const emit = (from: number, to: number) => {
    for (const segment of segments(nonSpoken, from, to)) {
      const asWritten = escapeHtml(
        terpnosLogos.slice(segment.from, segment.to),
      );
      out.push(segment.nonSpoken ? nonSpokenSpan(asWritten) : asWritten);
    }
  };

  /**
   * One skipped passage, one continuous block, punctuation included. Non-spoken
   * content caught inside it is never struck through: it was never to be read.
   */
  const emitOmission = (from: number, to: number) => {
    for (const segment of segments(nonSpoken, from, to)) {
      const skipped = terpnosLogos.slice(segment.from, segment.to);
      if (segment.nonSpoken) {
        out.push(nonSpokenSpan(escapeHtml(skipped)));
        continue;
      }
      // Whitespace hugging non-spoken content is not part of the passage.
      const lead = skipped.length - skipped.trimStart().length;
      const tail = skipped.length - skipped.trimEnd().length;
      if (lead === skipped.length) {
        out.push(escapeHtml(skipped));
        continue;
      }
      out.push(escapeHtml(skipped.slice(0, lead)));
      out.push(
        span(
          "omission",
          lastSpokenStart,
          escapeHtml(skipped.slice(lead, skipped.length - tail)),
        ),
      );
      out.push(escapeHtml(skipped.slice(skipped.length - tail)));
    }
  };

  for (const run of runs(ops)) {
    switch (run.kind) {
      case "equal": {
        for (const op of run.ops) {
          const word = written[op.left];
          emit(cursor, word.to);
          cursor = word.to;
          lastSpokenStart = heard[op.right].start;
          anythingRendered = true;
        }
        break;
      }

      case "omission": {
        const first = written[run.ops[0].left];
        const last = written[run.ops[run.ops.length - 1].left];
        emit(cursor, first.from);
        emitOmission(first.from, last.to);
        cursor = last.to;
        anythingRendered = true;
        break;
      }

      case "addition": {
        const added = run.ops.map((op) => heard[op.right]);
        // Punctuation closing the previous written word stays attached to it;
        // the addition goes after it, and before any line break that follows.
        const attached = anythingRendered
          ? (/^[^\s\p{L}\p{N}\[\]]*/u.exec(terpnosLogos.slice(cursor))?.[0] ??
            "")
          : "";
        out.push(escapeHtml(attached));
        cursor += attached.length;

        const said = span(
          "addition",
          added[0].start,
          escapeHtml(spokenText(added)),
        );
        // The addition sits between two written words; a space keeps it apart.
        out.push(anythingRendered ? ` ${said}` : `${said} `);
        lastSpokenStart = added[added.length - 1].start;
        break;
      }
    }
  }

  emit(cursor, terpnosLogos.length);
  return out.join("");
}

/** Consecutive operations of one kind: one difference, not a scatter of words. */
type Run =
  | { kind: "equal"; ops: Extract<DiffOp, { kind: "equal" }>[] }
  | { kind: "omission"; ops: Extract<DiffOp, { kind: "omission" }>[] }
  | { kind: "addition"; ops: Extract<DiffOp, { kind: "addition" }>[] };

function runs(ops: DiffOp[]): Run[] {
  const grouped: Run[] = [];
  for (const op of ops) {
    const last = grouped[grouped.length - 1];
    if (last && last.kind === op.kind) (last.ops as DiffOp[]).push(op);
    else grouped.push({ kind: op.kind, ops: [op] } as Run);
  }
  return grouped;
}

/** What the transcription heard, one entry per spoken word. */
function spokenText(words: TranscriptWord[]): string {
  const said: string[] = [];
  let previousIndex = -1;
  for (const word of words) {
    if (word.heardIndex === previousIndex) continue;
    said.push(word.display);
    previousIndex = word.heardIndex;
  }
  return said.join(" ");
}

function span(
  kind: "addition" | "omission",
  start: number,
  content: string,
): string {
  return `<span class="${kind}" data-start="${Math.round(start)}">${content}</span>`;
}

function nonSpokenSpan(content: string): string {
  return `<span class="non-spoken">${content}</span>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlDocument(body: string): string {
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
