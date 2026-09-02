export type DiffOp =
  | { kind: "equal"; left: number; right: number }
  | { kind: "omission"; left: number }
  | { kind: "addition"; right: number };

/**
 * Myers O(ND) difference. The two sequences are close by construction — a
 * faithful reading of a terpnos logos — so D stays small. A naive LCS table
 * would allocate ~144 MB on a 2,000-word session.
 */
export function diff(
  left: readonly string[],
  right: readonly string[],
): DiffOp[] {
  const n = left.length;
  const m = right.length;
  if (n === 0 && m === 0) return [];

  const max = n + m;
  const offset = max + 1;
  const furthest = new Int32Array(2 * max + 3);
  // One snapshot per edit distance, narrowed to the diagonals it can reach.
  const trace: Int32Array[] = [];

  let reached = -1;
  for (let d = 0; d <= max && reached < 0; d++) {
    trace.push(furthest.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d ||
        (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1])
          ? furthest[offset + k + 1]
          : furthest[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && left[x] === right[y]) {
        x++;
        y++;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) {
        reached = d;
        break;
      }
    }
  }

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d];
    const at = (diagonal: number) => snapshot[diagonal + d];
    const k = x - y;
    const previousK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      ops.push({ kind: "equal", left: x - 1, right: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === previousX) {
        ops.push({ kind: "addition", right: y - 1 });
        y--;
      } else {
        ops.push({ kind: "omission", left: x - 1 });
        x--;
      }
    }
  }

  return ops.reverse();
}
