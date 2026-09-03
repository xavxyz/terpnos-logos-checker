import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { detachedExec, type ExecutingHandle } from "./detached-exec.mts";

/**
 * A sandbox whose commands really run, over a link that really breaks.
 *
 * The point of the fake is the failure mode, not the shell: when the link drops
 * it rejects the caller's promise and *leaves the child running*, which is what
 * the Vercel sandbox does. The command lives server-side; only the HTTP stream
 * carrying its result dies. A fake that killed the child would model a
 * different bug and would let a wrong fix pass.
 */
const fakeSandbox = (linkLifetimeMs?: number) => {
  const commands: { command: string; durationMs: number }[] = [];

  const handle: ExecutingHandle & { commands: typeof commands } = {
    commands,
    copyIn: (hostPath, sandboxPath) => copyFile(hostPath, sandboxPath),
    exec: (command, options) =>
      new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn("sh", ["-c", command], { cwd: options?.cwd });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));

        let dropped = false;
        const drop =
          linkLifetimeMs === undefined
            ? undefined
            : setTimeout(() => {
                dropped = true;
                commands.push({ command, durationMs: Date.now() - startedAt });
                // Deliberately no `child.kill()`.
                reject(new Error("terminated"));
              }, linkLifetimeMs);

        child.on("close", (code) => {
          if (dropped) return;
          clearTimeout(drop);
          commands.push({ command, durationMs: Date.now() - startedAt });
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
      }),
  };

  return handle;
};

/** Runs for ~600 ms and prints as it goes, like an agent but faster. */
const SLOW = "for i in 1 2 3 4 5 6; do echo line-$i; sleep 0.1; done";

/** Well under the 600 ms command, well over any single poll. */
const LINK_LIFETIME_MS = 150;

const FAST_POLLING = { pollIntervalMs: 20 } as const;

describe("a command that outlives the link", () => {
  it("is lost when the caller holds the stream open for its whole run", async () => {
    const sandbox = fakeSandbox(LINK_LIFETIME_MS);

    // This is what `@vercel/sandbox` does today, and what Sandcastle's Vercel
    // provider inherits: one `exec` held open from launch to exit.
    await expect(sandbox.exec(SLOW)).rejects.toThrow("terminated");
  });

  it("completes when it is launched detached and polled", async () => {
    const sandbox = fakeSandbox(LINK_LIFETIME_MS);

    const result = await detachedExec(sandbox, SLOW, {}, FAST_POLLING);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("line-1\nline-2\nline-3\nline-4\nline-5\nline-6\n");
  });

  it("keeps every request short enough that no idle timeout can reach it", async () => {
    const sandbox = fakeSandbox(LINK_LIFETIME_MS);

    await detachedExec(sandbox, SLOW, {}, FAST_POLLING);

    const longest = Math.max(...sandbox.commands.map((entry) => entry.durationMs));
    expect(longest).toBeLessThan(LINK_LIFETIME_MS);
  });
});

describe("the handle contract", () => {
  it("streams whole lines as they are produced, not all at the end", async () => {
    const sandbox = fakeSandbox();
    const lines: string[] = [];
    let seenBeforeHalfway = 0;

    const command = "echo first; sleep 0.3; echo second";
    const started = Date.now();
    await detachedExec(
      sandbox,
      command,
      {
        onLine: (line) => {
          lines.push(line);
          if (Date.now() - started < 250) seenBeforeHalfway = lines.length;
        },
      },
      FAST_POLLING,
    );

    expect(lines).toEqual(["first", "second"]);
    // Buffered-until-exit would leave this at zero, which the
    // `IsolatedSandboxHandle` contract explicitly forbids.
    expect(seenBeforeHalfway).toBe(1);
  });

  it("reports a non-zero exit code rather than throwing", async () => {
    const sandbox = fakeSandbox();

    const result = await detachedExec(sandbox, "echo nope >&2; exit 3", {}, FAST_POLLING);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("nope\n");
    expect(result.stdout).toBe("");
  });

  it("pipes stdin to the command", async () => {
    const sandbox = fakeSandbox();

    const result = await detachedExec(sandbox, "cat", { stdin: "prompt body\n" }, FAST_POLLING);

    expect(result.stdout).toBe("prompt body\n");
  });

  it("keeps multi-byte output intact across polls", async () => {
    const sandbox = fakeSandbox();

    const result = await detachedExec(
      sandbox,
      "printf 'séance\\n'; sleep 0.2; printf 'terpnos logos\\n'",
      {},
      FAST_POLLING,
    );

    expect(result.stdout).toBe("séance\nterpnos logos\n");
  });
});

describe("a flaky link", () => {
  const failingPolls = (sandbox: ExecutingHandle, failures: number): ExecutingHandle => {
    let seen = 0;
    return {
      copyIn: sandbox.copyIn.bind(sandbox),
      exec: (command, options) => {
        if (command.startsWith("cat /tmp/") && ++seen <= failures) {
          return Promise.reject(new Error("terminated"));
        }
        return sandbox.exec(command, options);
      },
    };
  };

  it("retries a dropped poll against a command that is still running", async () => {
    const sandbox = failingPolls(fakeSandbox(), 3);

    const result = await detachedExec(sandbox, SLOW, {}, FAST_POLLING);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("line-1\nline-2\nline-3\nline-4\nline-5\nline-6\n");
  });

  it("gives up once the sandbox stops answering altogether", async () => {
    const sandbox = failingPolls(fakeSandbox(), Number.MAX_SAFE_INTEGER);

    await expect(
      detachedExec(sandbox, SLOW, {}, { ...FAST_POLLING, maxPollFailures: 3 }),
    ).rejects.toThrow("lost contact with the sandbox");
  });
});
