import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/commands/init.js";
import { cleanup, createBareRemote, createTempDir } from "./helpers.js";

const temps: string[] = [];

async function mktemp(): Promise<string> {
  const d = await createTempDir();
  temps.push(d);
  return d;
}

afterEach(async () => {
  for (const d of temps.splice(0)) {
    await cleanup(d);
  }
});

// BUG-011: `wt` with no arguments crashes with Ink "Raw mode is not supported"
// when stdin is not a TTY. The fix detects non-TTY stdin and prints a clean
// error message instead of launching the TUI.

describe("wt (no args) with non-TTY stdin — BUG-011", () => {
  it("prints a clean error and exits 1 instead of crashing with a stack trace", async () => {
    const remoteDir = await mktemp();
    await createBareRemote(remoteDir);

    const containerDir = await mktemp();
    await runInit({ url: `file://${remoteDir}`, cwd: containerDir });

    // Find the first slot directory to run wt from inside a worktree
    const entries = await fs.readdir(containerDir, { withFileTypes: true });
    const slotDir = entries.find((e) => e.isDirectory() && e.name !== ".wt");
    expect(slotDir).toBeDefined();
    const slotPath = path.join(containerDir, slotDir!.name);

    // Run the wt binary with no arguments and stdin from /dev/null (non-TTY)
    const result = await execa("node", [path.join(process.cwd(), "bin/wt.mjs")], {
      cwd: slotPath,
      input: "", // non-TTY: pipe from empty string
      reject: false,
    });

    // Should exit 1 (not 0, not 139/segfault, not 13)
    expect(result.exitCode).toBe(1);

    // Should print the clean error message
    expect(result.stderr).toContain("wt: TUI requires an interactive terminal");

    // Should NOT contain Ink's raw mode error or Node stack traces
    expect(result.stderr).not.toContain("Raw mode is not supported");
    expect(result.stderr).not.toContain("at file://");
  });
});
