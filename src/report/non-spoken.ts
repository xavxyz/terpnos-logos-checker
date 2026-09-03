/** A stretch of the terpnos logos, as offsets into it: [from, to). */
export type TextRange = { from: number; to: number };

/** A stretch of the terpnos logos, and whether it is meant to be read aloud. */
export type Segment = TextRange & { nonSpoken: boolean };

const OPENING = "[";
const CLOSING = "]";

/**
 * Non-spoken content: the parts the sophrologist marked between brackets —
 * production headers, section headings, working abbreviations. Automatic
 * detection was rejected as unpredictable, so only the brackets count.
 *
 * A bracket that is never closed is ordinary text: it must not swallow the rest
 * of the document. So is a bracket that a second one opens before it closes.
 */
export function nonSpokenRanges(terpnosLogos: string): TextRange[] {
  const ranges: TextRange[] = [];
  let opened = -1;

  for (let index = 0; index < terpnosLogos.length; index++) {
    const character = terpnosLogos[index];
    if (character === OPENING) opened = index;
    else if (character === CLOSING && opened >= 0) {
      ranges.push({ from: opened, to: index + 1 });
      opened = -1;
    }
  }

  return ranges;
}

/** The stretch [from, to), cut into spoken and non-spoken segments, in order. */
export function segments(
  ranges: readonly TextRange[],
  from: number,
  to: number,
): Segment[] {
  const cut: Segment[] = [];
  let cursor = from;

  for (const range of ranges) {
    if (range.to <= from) continue;
    if (range.from >= to) break;
    const start = Math.max(range.from, from);
    const end = Math.min(range.to, to);
    if (start > cursor) cut.push({ from: cursor, to: start, nonSpoken: false });
    cut.push({ from: start, to: end, nonSpoken: true });
    cursor = end;
  }

  if (cursor < to) cut.push({ from: cursor, to, nonSpoken: false });
  return cut;
}
