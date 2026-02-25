// BUG-019: Git errors double-printed — ExecaError message appended after git stderr
//
// When a git command fails, git's own error is already printed to stderr via
// stdio inherit. The CLI catch blocks must NOT print an additional
// "wt: Command failed with exit code N: git ..." line on top of it.

import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { createTempDir, createBareRemote, cleanup } from "./helpers.js";

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

const BIN = path.join(process.cwd(), "bin/wt.mjs");

async function setupContainer(): Promise<{ containerDir: string; slotDir: string }> {
  const remoteDir = await mktemp();
  await createBareRemote(remoteDir);

  const containerDir = await mktemp();
  await runInit({ url: `file://${remoteDir}`, cwd: containerDir });

  const { default: fs } = await import("node:fs/promises");
  const entries = await fs.readdir(containerDir, { withFileTypes: true });
  const slot = entries.find((e) => e.isDirectory() && e.name !== ".wt");
  if (!slot) throw new Error("No slot directory found after init");

  return { containerDir, slotDir: path.join(containerDir, slot.name) };
}

describe("CLI error handling — BUG-019", () => {
  it("does not print 'Command failed with exit code' after git error on checkout of nonexistent branch", async () => {
    const { slotDir } = await setupContainer();

    const result = await execa(
      "node",
      [BIN, "checkout", "totally-nonexistent-branch-xyz"],
      { cwd: slotDir, reject: false }
    );

    // Must exit non-zero
    expect(result.exitCode).not.toBe(0);

    // Must NOT contain the ExecaError message leak
    expect(result.stderr).not.toContain("Command failed with exit code");
    expect(result.stderr).not.toContain("wt: Command failed");
  });

  it("does not print 'Command failed with exit code' when -b branch already exists", async () => {
    const { slotDir } = await setupContainer();

    const result = await execa(
      "node",
      [BIN, "checkout", "-b", "main"],
      { cwd: slotDir, reject: false }
    );

    // Must exit non-zero
    expect(result.exitCode).not.toBe(0);

    // Must NOT contain the ExecaError message leak
    expect(result.stderr).not.toContain("Command failed with exit code");
    expect(result.stderr).not.toContain("wt: Command failed");
  });
});
