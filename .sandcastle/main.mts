/**
 * Sandcastle orchestrator for terpnos-logos-checker.
 *
 * Runs on your machine. Each issue gets one Claude Code agent in a fresh Vercel
 * Sandbox microVM; the agent implements the issue, proves it green in the
 * sandbox, and commits. Sandcastle syncs those commits back to this checkout,
 * and everything that touches GitHub happens here on the host — the sandbox
 * never holds a GitHub token, an AssemblyAI key, or a Blob token.
 *
 *   npx tsx .sandcastle/main.mts               # the whole pipeline
 *   npx tsx .sandcastle/main.mts --only 11     # one issue
 *   npx tsx .sandcastle/main.mts --dry-run     # print the plan, run nothing
 */

import { execFileSync } from "node:child_process";
import { claudeCode, Output, run } from "@ai-hero/sandcastle";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";
import { z } from "zod";

const REPO = "xavxyz/terpnos-logos-checker";
const BASE_BRANCH = "master";
const MODEL = process.env.SANDCASTLE_MODEL ?? "claude-opus-5";

/**
 * Issues in dependency order. Each inner array is a wave whose issues have no
 * dependency on each other and run concurrently; the next wave starts only once
 * the current one has fully landed on `master`.
 *
 * #11 scaffolds the project. Then the two chains run in parallel — {2,6,7} is
 * the I/O side (app shell, Blob upload, transcription) and {3,4} is the pure
 * comparison side — converging on #8, which unblocks #9 and #10.
 */
const WAVES: number[][] = [[11], [2, 3], [6, 4], [7], [8], [9, 10]];

/**
 * Issues whose pull request is opened as a draft and left for a human. These
 * three establish the patterns every later issue inherits — the project
 * scaffolding, the auth shape, and the `buildReport` seam — so a mistake here
 * is a mistake in eight downstream issues. Everything else self-merges once its
 * gates are green and every acceptance criterion is met.
 */
const REVIEW_BY_HUMAN = new Set([11, 2, 3]);

/**
 * Vercel Hobby caps a sandbox session at 45 minutes. Sandcastle's Vercel
 * provider defaults to 5 minutes and never calls `extendTimeout()`, so this
 * must be set explicitly or long runs die for no visible reason.
 */
const SANDBOX_TIMEOUT_MS = 44 * 60 * 1000;

/**
 * Each vCPU carries 2 GB of memory. Hobby allows up to 4, but the free tier's
 * real ceiling is 5 Active-CPU-hours per month — and once it is spent, sandbox
 * creation is paused until the billing cycle resets. Two vCPUs is enough for
 * `npm install` and `next build` and leaves headroom for retries.
 */
const VCPUS = 2;

/** The agent's self-assessment against its issue's acceptance criteria. */
const Verdict = z.object({
  gates: z.object({
    typecheck: z.boolean(),
    tests: z.boolean(),
    build: z.boolean(),
  }),
  criteria: z.array(
    z.object({
      text: z.string(),
      met: z.boolean(),
      note: z.string().default(""),
    }),
  ),
  summary: z.string(),
});

type Verdict = z.infer<typeof Verdict>;

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

const gh = (...args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8" }).trim();

const log = (issue: number, message: string) =>
  console.log(`[#${issue}] ${message}`);

const issueTitle = (issue: number) =>
  gh("issue", "view", String(issue), "--repo", REPO, "--json", "title", "-q", ".title");

/**
 * Reasons this run must not be merged. Empty means the agent cleared every bar
 * its issue set.
 */
const blockers = (verdict: Verdict): string[] => {
  const failed = Object.entries(verdict.gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => `gate failed: ${gate}`);

  const unmet = verdict.criteria
    .filter((criterion) => !criterion.met)
    .map((criterion) => `unmet: ${criterion.text}${criterion.note ? ` — ${criterion.note}` : ""}`);

  return [...failed, ...unmet];
};

/**
 * Implement one issue in a sandbox and, if it comes back clean, land it.
 * Returns the pull request URL.
 */
const implementIssue = async (issue: number): Promise<string> => {
  const branch = `agent/issue-${issue}`;
  const title = issueTitle(issue);
  log(issue, `${title}`);
  log(issue, `branch ${branch}, model ${MODEL}`);

  const result = await run({
    name: `issue-${issue}`,
    agent: claudeCode(MODEL),
    sandbox: vercel({
      timeout: SANDBOX_TIMEOUT_MS,
      resources: { vcpus: VCPUS },
      runtime: "node24",
    }),
    promptFile: `${process.cwd()}/.sandcastle/prompt.md`,
    promptArgs: { ISSUE_NUMBER: issue },
    // Concurrent runs in the same wave must not share a branch. `head` and
    // `merge-to-head` are unsafe for concurrent work; a named branch per issue
    // is the only strategy that is.
    branchStrategy: { type: "branch", branch, baseBranch: BASE_BRANCH },
    hooks: {
      sandbox: {
        onSandboxReady: [
          // The Vercel provider ignores `.sandcastle/Dockerfile` entirely — it
          // is a bind-mount/Docker concept. Without this the `claude` binary
          // does not exist in the sandbox and the run fails immediately.
          {
            command:
              'curl -fsSL https://claude.ai/install.sh | bash && ' +
              'sudo ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude || true',
            timeoutMs: 180_000,
          },
        ],
      },
    },
    output: Output.object({ tag: "verdict", schema: Verdict, maxRetries: 2 }),
  });

  const verdict: Verdict = result.output;
  log(issue, `${result.commits.length} commit(s) on ${result.branch}`);
  log(issue, verdict.summary);

  const problems = blockers(verdict);
  if (problems.length > 0) {
    throw new Error(
      `Issue #${issue} came back incomplete:\n  ${problems.join("\n  ")}\n` +
        `Commits are on the local branch ${branch}. Inspect, fix or re-run.`,
    );
  }

  if (result.commits.length === 0) {
    throw new Error(`Issue #${issue} produced no commits.`);
  }

  git("push", "--force-with-lease", "-u", "origin", branch);

  const body =
    `${verdict.summary}\n\n` +
    `Closes #${issue}\n\n` +
    `Implemented autonomously by Sandcastle. Acceptance criteria self-reported met:\n` +
    verdict.criteria.map((criterion) => `- [x] ${criterion.text}`).join("\n");

  const prUrl = gh(
    "pr", "create",
    "--repo", REPO,
    "--base", BASE_BRANCH,
    "--head", branch,
    "--title", `${title} (#${issue})`,
    "--body", body,
    ...(REVIEW_BY_HUMAN.has(issue) ? ["--draft"] : []),
  );

  if (REVIEW_BY_HUMAN.has(issue)) {
    log(issue, `draft PR awaiting your review: ${prUrl}`);
    return prUrl;
  }

  gh("pr", "merge", prUrl, "--repo", REPO, "--squash", "--delete-branch");
  git("checkout", BASE_BRANCH);
  git("pull", "--ff-only", "origin", BASE_BRANCH);
  log(issue, `merged: ${prUrl}`);
  return prUrl;
};

const main = async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex === -1 ? undefined : Number(args[onlyIndex + 1]);

  const waves = only ? [[only]] : WAVES;

  if (dryRun) {
    console.log(`Repo: ${REPO}, base: ${BASE_BRANCH}, model: ${MODEL}`);
    waves.forEach((wave, index) => {
      const labelled = wave.map(
        (issue) => `#${issue}${REVIEW_BY_HUMAN.has(issue) ? " (draft, human review)" : " (auto-merge)"}`,
      );
      console.log(`Wave ${index + 1}: ${labelled.join(", ")}`);
    });
    return;
  }

  if (git("status", "--porcelain") !== "") {
    throw new Error("Working tree is dirty. Commit or stash before running.");
  }

  git("fetch", "origin");
  git("checkout", BASE_BRANCH);
  git("pull", "--ff-only", "origin", BASE_BRANCH);

  for (const [index, wave] of waves.entries()) {
    console.log(`\n=== Wave ${index + 1}/${waves.length}: ${wave.map((n) => `#${n}`).join(", ")} ===`);
    // Whole wave in parallel; a rejection stops the pipeline before the next
    // wave builds on work that never landed.
    await Promise.all(wave.map(implementIssue));
  }

  console.log("\nPipeline complete.");
};

await main();
