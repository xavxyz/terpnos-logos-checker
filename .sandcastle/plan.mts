/**
 * Which issues a wave should attempt, given what is already done and what has
 * already failed in this run.
 *
 * Kept pure and free of I/O so the scheduling rules can be exercised without a
 * sandbox, a network or a git checkout: `main.mts` supplies the closed set, the
 * failures it has accumulated so far, and the dependency graph it read from
 * GitHub, and gets back a decision per issue.
 */

/** Why an issue in a wave is not being handed to an agent. */
export type Skip =
  /** Its pull request is already merged and the issue closed. */
  | { readonly kind: "done" }
  /** Work it depends on failed earlier in this run. */
  | { readonly kind: "blocked"; readonly by: readonly number[] };

export interface WavePlan {
  /** Issues to hand to an agent, in the order the wave listed them. */
  readonly todo: readonly number[];
  /** The rest of the wave, each with the reason it was passed over. */
  readonly skipped: ReadonlyMap<number, Skip>;
}

/**
 * `issue` -> the issues that must land before it can be built.
 *
 * Read from GitHub's native issue dependencies, which
 * `docs/agents/issue-tracker.md` names the canonical, UI-visible
 * representation. Deriving it beats hardcoding a second copy here that would
 * drift the first time a dependency is added in the GitHub UI.
 */
export type Blockers = ReadonlyMap<number, readonly number[]>;

export interface PipelineState {
  /** Issues already closed by a merged pull request. */
  readonly closed: ReadonlySet<number>;
  /** Issues whose agent or landing failed in this run. */
  readonly failed: ReadonlySet<number>;
  /** `null` when the dependency graph could not be read from GitHub. */
  readonly blockers: Blockers | null;
}

/**
 * The failed issues that `issue` transitively waits on, ascending.
 *
 * Transitive rather than direct, because a failure two waves back still makes
 * an issue unbuildable: #8 is blocked by #7, which is blocked by #6, so when
 * #6's agent dies #8 cannot be attempted either — even though #7 itself never
 * failed, it was merely skipped.
 *
 * Walks defensively against a cycle rather than trusting the graph, since the
 * cost of misplaced trust here is an orchestrator that hangs instead of one
 * that reports a bad edge.
 */
export const failedAncestors = (
  issue: number,
  blockers: Blockers,
  failed: ReadonlySet<number>,
): number[] => {
  const found = new Set<number>();
  const seen = new Set<number>();

  const walk = (current: number): void => {
    if (seen.has(current)) return;
    seen.add(current);

    for (const blocker of blockers.get(current) ?? []) {
      if (failed.has(blocker)) found.add(blocker);
      walk(blocker);
    }
  };

  // Starts at `issue` rather than at its blockers so that an issue which itself
  // failed is not reported as blocking itself: a failed issue is retried, not
  // skipped.
  walk(issue);
  return [...found].sort((a, b) => a - b);
};

export const planWave = (wave: readonly number[], state: PipelineState): WavePlan => {
  const todo: number[] = [];
  const skipped = new Map<number, Skip>();

  for (const issue of wave) {
    // Checked before blocking: an issue that already landed is done regardless
    // of what happened to the work it once depended on.
    if (state.closed.has(issue)) {
      skipped.set(issue, { kind: "done" });
      continue;
    }

    // With no graph there is no way to tell which issues a failure actually
    // invalidates, so nothing further is attempted. Skipping an issue that
    // would have been fine costs one re-run; building one on work that never
    // landed costs a wave of metered agent time and a pull request that looks
    // finished and is not.
    const unmet =
      state.blockers === null
        ? [...state.failed].sort((a, b) => a - b)
        : failedAncestors(issue, state.blockers, state.failed);

    if (unmet.length > 0) {
      skipped.set(issue, { kind: "blocked", by: unmet });
      continue;
    }

    todo.push(issue);
  }

  return { todo, skipped };
};
