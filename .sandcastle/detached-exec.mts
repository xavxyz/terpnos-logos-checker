/**
 * Running a command in a sandbox without holding a socket open for its whole
 * life.
 *
 * `@vercel/sandbox`'s `runCommand({ wait: true })` opens one NDJSON HTTP stream
 * per command and reads exactly two chunks from it: one when the command
 * starts, one when it exits. Between those, for an agent run, the socket is
 * silent for an hour or more. Anything on the path with an idle timeout — the
 * Vercel edge, a NAT, a home router, a VPN — closes it, and the SDK turns that
 * into `Stream ended before command finished` (clean FIN) or lets undici's
 * `terminated` (reset) through. Both mean the same thing, and neither means the
 * command failed: the sandbox is still working, the client just hung up. The
 * run is lost anyway, because Sandcastle only syncs commits back at the end.
 *
 * So don't hold the socket. Write the command to a script inside the sandbox,
 * launch it detached, and poll for its exit code with short execs. Every
 * request is now sub-second, so no idle timeout can reach it, and a poll that
 * does fail is retried against a process that is still running.
 *
 * `onLine` still fires as output arrives — the `IsolatedSandboxHandle` contract
 * requires it, and Sandcastle's idle timeouts are built on it — because each
 * poll tails only the bytes written since the last one.
 */

import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The subset of `IsolatedSandboxHandle` this needs. */
export interface ExecutingHandle {
  exec(
    command: string,
    options?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
}

export interface DetachedExecOptions {
  readonly onLine?: (line: string) => void;
  readonly cwd?: string;
  readonly sudo?: boolean;
  readonly stdin?: string;
}

export interface DetachedExecConfig {
  /** Gap between polls. Short enough for live output, long enough to be cheap. */
  readonly pollIntervalMs?: number;
  /** Consecutive poll failures tolerated before giving up on the command. */
  readonly maxPollFailures?: number;
  /** Give up once the command has run this long. */
  readonly timeoutMs?: number;
  /** Seam for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  pollIntervalMs: 5_000,
  maxPollFailures: 10,
  timeoutMs: 44 * 60 * 1000,
} as const;

/**
 * Separates the three fields of a poll response. `0x1c` (ASCII file separator)
 * cannot appear in the output being framed: the streams carried here are JSON,
 * and JSON escapes every control character below `0x20`.
 */
const FIELD = "\u001c";

/** Distinct per command, and per orchestrator process sharing a sandbox. */
let sequence = 0;
const nextId = () => `sandcastle-${process.pid}-${Date.now()}-${++sequence}`;

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Paths {
  readonly script: string;
  readonly out: string;
  readonly err: string;
  readonly rc: string;
  readonly stdin: string;
}

const pathsFor = (id: string): Paths => ({
  script: `/tmp/${id}.sh`,
  out: `/tmp/${id}.out`,
  err: `/tmp/${id}.err`,
  rc: `/tmp/${id}.rc`,
  stdin: `/tmp/${id}.stdin`,
});

/**
 * The script the sandbox actually runs. `$?` is captured into the exit-code
 * file only after the command's own redirections have closed, which is what
 * lets a poller treat "the exit-code file exists" as "stdout and stderr are
 * complete".
 */
const script = (command: string, paths: Paths, stdinPath: string | undefined): string =>
  [
    "#!/bin/sh",
    `( ${command} ) < ${stdinPath ?? "/dev/null"} > ${paths.out} 2> ${paths.err}`,
    `echo $? > ${paths.rc}`,
    "",
  ].join("\n");

/** Copy a string into the sandbox without leaving it on the host. */
const putFile = async (
  handle: ExecutingHandle,
  contents: string,
  sandboxPath: string,
): Promise<void> => {
  const hostPath = join(tmpdir(), `sandcastle-put-${process.pid}-${++sequence}`);
  await writeFile(hostPath, contents, "utf8");
  try {
    await handle.copyIn(hostPath, sandboxPath);
  } finally {
    await rm(hostPath, { force: true });
  }
};

/**
 * Reads the exit code *before* the output, so that seeing one guarantees the
 * other is whole. The reverse order has a race: the command can finish between
 * the tail and the `cat`, and the last bytes of its output are then lost.
 */
const pollCommand = (paths: Paths, outOffset: number, errOffset: number): string =>
  [
    `cat ${paths.rc} 2>/dev/null`,
    `printf '\\034'`,
    `tail -c +${outOffset} ${paths.out} 2>/dev/null`,
    `printf '\\034'`,
    `tail -c +${errOffset} ${paths.err} 2>/dev/null`,
  ].join("; ");

/**
 * How much of a chunk can be consumed without splitting a character.
 *
 * `tail -c` counts bytes, so a chunk read while the command is still writing
 * can end in the middle of a multi-byte sequence; advancing the offset past it
 * would corrupt every later read. A newline is always a character boundary, so
 * while the command is running only whole lines are taken and the rest is left
 * in the file for the next poll. Once it has exited nothing more will be
 * written, so the remainder is safe to take.
 */
const consumable = (chunk: string, finished: boolean): string => {
  if (finished) return chunk;
  const lastBreak = chunk.lastIndexOf("\n");
  return lastBreak === -1 ? "" : chunk.slice(0, lastBreak + 1);
};

/** Emits whole lines as they appear, holding a trailing partial line back. */
const lineEmitter = (onLine?: (line: string) => void) => {
  let pending = "";
  return {
    push: (chunk: string): void => {
      if (onLine === undefined) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush: (): void => {
      if (onLine === undefined || pending === "") return;
      onLine(pending);
      pending = "";
    },
  };
};

export const detachedExec = async (
  handle: ExecutingHandle,
  command: string,
  options: DetachedExecOptions = {},
  config: DetachedExecConfig = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const maxPollFailures = config.maxPollFailures ?? DEFAULTS.maxPollFailures;
  const timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
  const sleep = config.sleep ?? sleepFor;

  const paths = pathsFor(nextId());
  const { onLine, cwd, sudo, stdin } = options;

  if (stdin !== undefined) await putFile(handle, stdin, paths.stdin);
  await putFile(
    handle,
    script(command, paths, stdin === undefined ? undefined : paths.stdin),
    paths.script,
  );

  // The subshell detaches the job from this exec, so the launching command
  // returns as soon as the script is running rather than when it finishes.
  await handle.exec(`( nohup sh ${paths.script} > /dev/null 2>&1 < /dev/null & ) ; echo launched`, {
    cwd,
    sudo,
  });

  const out = lineEmitter(onLine);
  const err = lineEmitter(onLine);
  let stdout = "";
  let stderr = "";
  let outOffset = 1;
  let errOffset = 1;
  let failures = 0;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    await sleep(pollIntervalMs);

    let response: { stdout: string };
    try {
      response = await handle.exec(pollCommand(paths, outOffset, errOffset), { cwd, sudo });
      failures = 0;
    } catch (error) {
      // The command itself is unaffected by a failed poll — it is a detached
      // process in the sandbox, not a child of this request. Retrying is the
      // whole point of polling.
      if (++failures > maxPollFailures) {
        throw new Error(
          `lost contact with the sandbox after ${failures} consecutive failed polls: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    const [rawCode = "", rawOut = "", rawErr = ""] = response.stdout.split(FIELD);
    const finished = rawCode.trim() !== "";

    const outChunk = consumable(rawOut, finished);
    const errChunk = consumable(rawErr, finished);
    stdout += outChunk;
    stderr += errChunk;
    out.push(outChunk);
    err.push(errChunk);
    outOffset += Buffer.byteLength(outChunk, "utf8");
    errOffset += Buffer.byteLength(errChunk, "utf8");

    if (finished) {
      out.flush();
      err.flush();
      const exitCode = Number.parseInt(rawCode.trim(), 10);
      if (Number.isNaN(exitCode)) {
        throw new Error(`sandbox reported an unreadable exit code: ${JSON.stringify(rawCode)}`);
      }
      // Best-effort: the sandbox is torn down after the run anyway.
      await handle
        .exec(`rm -f ${paths.script} ${paths.out} ${paths.err} ${paths.rc} ${paths.stdin}`, {
          cwd,
          sudo,
        })
        .catch(() => undefined);
      return { stdout, stderr, exitCode };
    }

    if (Date.now() > deadline) {
      throw new Error(`command did not finish within ${timeoutMs} ms: ${command}`);
    }
  }
};
