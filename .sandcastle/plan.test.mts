import { describe, expect, it } from "vitest";

import { failedAncestors, planWave, type Blockers } from "./plan.mts";

/** The real pipeline's shape, as registered in GitHub's issue dependencies. */
const BLOCKERS: Blockers = new Map([
  [2, [11]],
  [3, [11]],
  [6, [2]],
  [4, [3]],
  [7, [6]],
  [8, [4, 7]],
  [9, [8]],
  [10, [8]],
]);

const none = new Set<number>();

describe("failedAncestors", () => {
  it("finds nothing when nothing failed", () => {
    expect(failedAncestors(8, BLOCKERS, none)).toEqual([]);
  });

  it("finds a direct blocker that failed", () => {
    expect(failedAncestors(7, BLOCKERS, new Set([6]))).toEqual([6]);
  });

  it("finds a blocker two hops back, through an issue that never ran", () => {
    // #6 died, so #7 was skipped rather than failed — #8 is still unbuildable.
    expect(failedAncestors(8, BLOCKERS, new Set([6]))).toEqual([6]);
  });

  it("reports every failed ancestor, deduplicated and ordered", () => {
    expect(failedAncestors(9, BLOCKERS, new Set([6, 4]))).toEqual([4, 6]);
  });

  it("ignores a failure on the other chain", () => {
    // #4 is the comparison side; #7 is the I/O side. They only meet at #8.
    expect(failedAncestors(7, BLOCKERS, new Set([4]))).toEqual([]);
  });

  it("treats an issue with no recorded blockers as unblocked", () => {
    expect(failedAncestors(11, BLOCKERS, new Set([6]))).toEqual([]);
  });

  it("does not count the issue's own failure against itself", () => {
    expect(failedAncestors(6, BLOCKERS, new Set([6]))).toEqual([]);
  });

  it("terminates on a cyclic graph", () => {
    const cyclic: Blockers = new Map([
      [1, [2]],
      [2, [3]],
      [3, [1]],
    ]);
    expect(failedAncestors(1, cyclic, new Set([3]))).toEqual([3]);
  });
});

describe("planWave", () => {
  it("attempts every open issue when nothing has failed", () => {
    const plan = planWave([6, 4], { closed: none, failed: none, blockers: BLOCKERS });
    expect(plan.todo).toEqual([6, 4]);
    expect(plan.skipped.size).toBe(0);
  });

  it("skips closed issues as already done", () => {
    const plan = planWave([2, 3], { closed: new Set([2, 3]), failed: none, blockers: BLOCKERS });
    expect(plan.todo).toEqual([]);
    expect(plan.skipped.get(2)).toEqual({ kind: "done" });
  });

  it("skips an issue whose blocker failed, naming the blocker", () => {
    const plan = planWave([7], { closed: none, failed: new Set([6]), blockers: BLOCKERS });
    expect(plan.todo).toEqual([]);
    expect(plan.skipped.get(7)).toEqual({ kind: "blocked", by: [6] });
  });

  it("keeps the unaffected chain running after a failure", () => {
    // #6 died on the I/O chain. #7 inherits that and cannot be built, but #4
    // sits on the comparison chain and must still be attempted.
    const plan = planWave([7, 4], { closed: none, failed: new Set([6]), blockers: BLOCKERS });
    expect(plan.todo).toEqual([4]);
    expect(plan.skipped.get(7)).toEqual({ kind: "blocked", by: [6] });
  });

  it("prefers 'done' over 'blocked' for an issue that already landed", () => {
    const plan = planWave([7], { closed: new Set([7]), failed: new Set([6]), blockers: BLOCKERS });
    expect(plan.skipped.get(7)).toEqual({ kind: "done" });
  });

  it("preserves wave order in todo", () => {
    const plan = planWave([9, 4, 6], { closed: none, failed: none, blockers: BLOCKERS });
    expect(plan.todo).toEqual([9, 4, 6]);
  });

  it("attempts everything when the graph is unavailable but nothing failed", () => {
    const plan = planWave([6, 4], { closed: none, failed: none, blockers: null });
    expect(plan.todo).toEqual([6, 4]);
  });

  it("attempts nothing once anything has failed and the graph is unavailable", () => {
    const plan = planWave([6, 4], { closed: none, failed: new Set([2]), blockers: null });
    expect(plan.todo).toEqual([]);
    expect(plan.skipped.get(6)).toEqual({ kind: "blocked", by: [2] });
    expect(plan.skipped.get(4)).toEqual({ kind: "blocked", by: [2] });
  });
});

/**
 * Replays whole runs the way `main.mts` does — planning each wave against the
 * failures accumulated by the ones before it — because the property that
 * matters is not what one wave decides but what the pipeline as a whole still
 * attempts after something dies.
 */
const runPipeline = (
  waves: readonly (readonly number[])[],
  { closed = none, failing = none }: { closed?: ReadonlySet<number>; failing?: ReadonlySet<number> },
) => {
  const failed = new Set<number>();
  const attempted: number[] = [];
  const skipped = new Map<number, readonly number[]>();

  for (const wave of waves) {
    const plan = planWave(wave, { closed, failed, blockers: BLOCKERS });
    for (const [issue, skip] of plan.skipped) {
      if (skip.kind === "blocked") skipped.set(issue, skip.by);
    }
    for (const issue of plan.todo) {
      attempted.push(issue);
      if (failing.has(issue)) failed.add(issue);
    }
  }

  return { attempted, skipped, failed };
};

describe("a run after an agent fails", () => {
  const WAVES = [[11], [2, 3], [6, 4], [7], [8], [9], [10]];
  const scaffoldingDone = new Set([11, 2, 3]);

  it("still attempts every wave when nothing fails", () => {
    const run = runPipeline(WAVES, { closed: scaffoldingDone });
    expect(run.attempted).toEqual([6, 4, 7, 8, 9, 10]);
    expect(run.skipped.size).toBe(0);
  });

  it("keeps going on the healthy chain when one agent dies", () => {
    // The incident this resilience exists for, minus the second casualty: #6's
    // sandbox dropped its exec stream. #4 is independent and must still run.
    const run = runPipeline(WAVES, { closed: scaffoldingDone, failing: new Set([6]) });
    expect(run.attempted).toEqual([6, 4]);
    // #7 needs #6; #8 needs #7; #9 and #10 need #8. None are buildable.
    expect([...run.skipped.keys()]).toEqual([7, 8, 9, 10]);
    expect(run.skipped.get(8)).toEqual([6]);
  });

  it("attempts nothing downstream when both agents in a wave die", () => {
    const run = runPipeline(WAVES, { closed: scaffoldingDone, failing: new Set([6, 4]) });
    expect(run.attempted).toEqual([6, 4]);
    expect(run.skipped.get(8)).toEqual([4, 6]);
  });

  it("loses only the failed issue when nothing depends on it", () => {
    const run = runPipeline(WAVES, { closed: scaffoldingDone, failing: new Set([9]) });
    // #10 depends on #8, not on #9 — their ordering is a UI collision, not a
    // dependency — so a dead #9 must not cost #10 as well.
    expect(run.attempted).toEqual([6, 4, 7, 8, 9, 10]);
    expect(run.skipped.size).toBe(0);
  });
});
