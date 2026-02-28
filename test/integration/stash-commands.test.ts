import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { runCheckout } from "../../src/commands/checkout.js";
import { runInit } from "../../src/commands/init.js";
import {
  runStashApply,
  runStashDrop,
  runStashList,
  runStashShow,
} from "../../src/commands/stash.js";
import { readConfig, writeConfig } from "../../src/core/config.js";
import { archiveStash, getStash } from "../../src/core/stash.js";
import { readState, writeState } from "../../src/core/state.js";
import { establishSymlinks } from "../../src/core/symlinks.js";
import { cleanup, createTempDir, createTestRepo } from "./helpers.js";

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

async function setupContainer(dir: string) {
  await createTestRepo(dir);
  await runInit({ cwd: dir });
  return {
    containerDir: dir,
    wtDir: path.join(dir, ".wt"),
    repoDir: path.join(dir, ".wt", "repo"),
  };
}

/**
 * Fill all slots and create a stash for 'main' by evicting it.
 * Uses a tracked file modification so git stash create captures the dirty state.
 * Forces main to be LRU so it's the one evicted.
 */
async function createStashViaEviction(
  containerDir: string,
  wtDir: string,
  repoDir: string,
): Promise<{ mainSlotName: string }> {
  const state = await readState(wtDir);
  const slotNames = Object.keys(state.slots);
  const mainSlotName = Object.entries(state.slots).find(([, s]) => s.branch === "main")?.[0];
  expect(mainSlotName).toBeDefined();

  // Modify a tracked file in the main slot to create dirty state
  const readmePath = path.join(containerDir, mainSlotName!, "README.md");
  await fs.writeFile(readmePath, "# Modified for stash test\n");

  // Force main to be LRU
  state.slots[mainSlotName!].last_used_at = new Date(0).toISOString();
  await writeState(wtDir, state);

  // Fill all remaining vacant slots
  const vacantCount = slotNames.length - 1;
  for (let i = 0; i < vacantCount; i++) {
    await execa("git", ["branch", `fill-${i}`], { cwd: repoDir });
    await runCheckout({ branch: `fill-${i}`, cwd: containerDir });
  }

  // Checkout one more branch — should evict main (it's LRU)
  await execa("git", ["branch", "stash-target"], { cwd: repoDir });
  await runCheckout({ branch: "stash-target", cwd: containerDir, noRestore: true });

  // Verify a stash was created for 'main'
  const stash = await getStash(wtDir, "main");
  expect(stash).not.toBeNull();

  return { mainSlotName: mainSlotName! };
}

describe("wt stash list", () => {
  it("displays saved stashes including the branch name", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);

    // Capture stdout
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };

    try {
      await runStashList({ cwd: dir });
    } finally {
      process.stdout.write = orig;
    }

    const output = lines.join("");
    expect(output).toContain("main");
    expect(output).toContain("active");
  });

  it("prints 'No saved stashes.' when none exist", async () => {
    const dir = await mktemp();
    await setupContainer(dir);

    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runStashList({ cwd: dir });
    } finally {
      process.stdout.write = orig;
    }

    expect(lines.join("")).toContain("No saved stashes");
  });
});

describe("wt stash apply", () => {
  it("restores dirty state and cleans up the stash", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);

    // Verify stash exists before apply
    expect(await getStash(wtDir, "main")).not.toBeNull();

    // Checkout main again so it's in a slot (with --no-restore to keep stash)
    // Make fill-0 LRU — it's clean, so main will be checked out into a clean working tree
    let state = await readState(wtDir);
    const fill0Slot = Object.entries(state.slots).find(([, s]) => s.branch === "fill-0")![0];
    state.slots[fill0Slot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    await runCheckout({ branch: "main", cwd: dir, noRestore: true });

    // Apply stash
    await runStashApply("main", { cwd: dir });

    // Stash should be cleaned up on success
    const stashAfter = await getStash(wtDir, "main");
    expect(stashAfter).toBeNull();

    // README.md should have the modified content
    state = await readState(wtDir);
    const mainSlotNew = Object.entries(state.slots).find(([, s]) => s.branch === "main")![0];
    const content = await fs.readFile(path.join(dir, mainSlotNew, "README.md"), "utf8");
    expect(content).toBe("# Modified for stash test\n");
  });

  it("throws when branch is not checked out in any slot", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);

    // 'main' has a stash but is NOT in any slot currently
    await expect(runStashApply("main", { cwd: dir })).rejects.toThrow("not checked out");
  });

  it("succeeds when slot has managed shared symlinks at apply time (BUG-007)", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    // Configure a shared directory
    const config = await readConfig(wtDir);
    config.shared.directories = [".config"];
    await writeConfig(wtDir, config);

    // Create a canonical shared file
    const canonicalDir = path.join(wtDir, "shared", ".config");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "app.json"), '{"key":"value"}');

    // Establish symlinks in all existing slots (simulating wt sync)
    const state = await readState(wtDir);
    for (const slotName of Object.keys(state.slots)) {
      await establishSymlinks(wtDir, path.join(dir, slotName), [".config"], "");
    }

    // Find the main slot and verify its symlink exists
    const mainSlot = Object.entries(state.slots).find(([, s]) => s.branch === "main")![0];
    const symlinkPath = path.join(dir, mainSlot, ".config", "app.json");
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);

    // Create dirty state (modify a tracked file) in the main slot
    await fs.writeFile(path.join(dir, mainSlot, "README.md"), "# BUG-007 dirty state\n");

    // Make main LRU so it will be evicted first
    state.slots[mainSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Fill all vacant slots
    const vacantCount = Object.values(state.slots).filter((s) => s.branch === null).length;
    for (let i = 0; i < vacantCount; i++) {
      await execa("git", ["branch", `bug007-fill-${i}`], { cwd: repoDir });
      await runCheckout({ branch: `bug007-fill-${i}`, cwd: dir });
    }

    // One more checkout — triggers LRU eviction of main (which has the symlink)
    await execa("git", ["branch", "bug007-evict"], { cwd: repoDir });
    await runCheckout({ branch: "bug007-evict", cwd: dir, noRestore: true });

    // Verify stash was saved for main
    const stash = await getStash(wtDir, "main");
    expect(stash).not.toBeNull();

    // Re-checkout main with --no-restore (so the symlink gets re-created by
    // establishSymlinks in checkout, but stash is NOT auto-applied)
    const stateAfterEvict = await readState(wtDir);
    const fill0Slot = Object.entries(stateAfterEvict.slots).find(
      ([, s]) => s.branch === "bug007-fill-0",
    )![0];
    stateAfterEvict.slots[fill0Slot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, stateAfterEvict);

    await runCheckout({ branch: "main", cwd: dir, noRestore: true });

    // Verify symlink was re-created by checkout
    const stateWithMain = await readState(wtDir);
    const mainSlotNew = Object.entries(stateWithMain.slots).find(
      ([, s]) => s.branch === "main",
    )![0];
    const newSymlinkPath = path.join(dir, mainSlotNew, ".config", "app.json");
    expect((await fs.lstat(newSymlinkPath)).isSymbolicLink()).toBe(true);

    // Apply the stash — must NOT fail with "already exists, no checkout" (BUG-007)
    await expect(runStashApply("main", { cwd: dir })).resolves.toBeUndefined();

    // Stash cleaned up on success
    expect(await getStash(wtDir, "main")).toBeNull();

    // The dirty README.md content was restored
    const content = await fs.readFile(path.join(dir, mainSlotNew, "README.md"), "utf8");
    expect(content).toBe("# BUG-007 dirty state\n");
  });
});

describe("wt stash drop", () => {
  it("removes stash metadata and git ref", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);

    expect(await getStash(wtDir, "main")).not.toBeNull();

    await runStashDrop("main", { cwd: dir, confirmYes: true });

    expect(await getStash(wtDir, "main")).toBeNull();
  });

  it("throws when no stash exists for branch", async () => {
    const dir = await mktemp();
    await setupContainer(dir);

    await expect(
      runStashDrop("nonexistent-branch", { cwd: dir, confirmYes: true }),
    ).rejects.toThrow("No stash found");
  });

  it("aborts cleanly when stdin closes without data (BUG-010)", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);
    expect(await getStash(wtDir, "main")).not.toBeNull();

    // Replace process.stdin with a PassThrough that immediately closes (simulates /dev/null)
    const origStdin = process.stdin;
    const fakeStdin = new PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      writable: true,
      configurable: true,
    });

    // Capture stdout
    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };

    try {
      // Close stdin after promptConfirm attaches listeners
      setTimeout(() => fakeStdin.end(), 10);
      await runStashDrop("main", { cwd: dir });
    } finally {
      process.stdout.write = origWrite;
      Object.defineProperty(process, "stdin", {
        value: origStdin,
        writable: true,
        configurable: true,
      });
    }

    // Stash should NOT be dropped — promptConfirm defaulted to "N"
    expect(await getStash(wtDir, "main")).not.toBeNull();
    const output = lines.join("");
    expect(output).toContain("Aborted");
  });

  it("aborts cleanly when stdin emits only 'end' (not 'close'), like /dev/null (BUG-018)", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);
    expect(await getStash(wtDir, "main")).not.toBeNull();

    // Simulate /dev/null: emits "end" but never "close"
    const origStdin = process.stdin;
    const fakeStdin = new PassThrough();
    // Suppress the "close" event to replicate /dev/null behaviour
    fakeStdin.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event === "close") return true; // swallow close
      return PassThrough.prototype.emit.call(this, event, ...args);
    };
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      writable: true,
      configurable: true,
    });

    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };

    try {
      // Trigger "end" only — no "close"
      setTimeout(() => fakeStdin.end(), 10);
      await runStashDrop("main", { cwd: dir });
    } finally {
      process.stdout.write = origWrite;
      Object.defineProperty(process, "stdin", {
        value: origStdin,
        writable: true,
        configurable: true,
      });
    }

    // Stash should NOT be dropped — promptConfirm defaulted to "N"
    expect(await getStash(wtDir, "main")).not.toBeNull();
    const output = lines.join("");
    expect(output).toContain("Aborted");
  });
});

describe("wt stash show", () => {
  it("outputs diff content for a saved stash", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);

    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runStashShow("main", { cwd: dir });
    } finally {
      process.stdout.write = orig;
    }

    // Diff output should be non-empty
    const output = lines.join("");
    expect(output.trim().length).toBeGreaterThan(0);
  });

  it("throws for a non-existent stash", async () => {
    const dir = await mktemp();
    await setupContainer(dir);

    await expect(runStashShow("no-such-branch", { cwd: dir })).rejects.toThrow("No stash found");
  });

  it("emits actionable error when archived stash patch file is missing (BUG-033)", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);

    // Archive the active stash directly
    await archiveStash(wtDir, repoDir, "main");

    const meta = await getStash(wtDir, "main");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("archived");
    expect(meta!.archive_path).toBeDefined();

    // Delete the archive file to simulate manual removal
    await fs.unlink(meta!.archive_path!);

    // Capture stderr
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") stderrLines.push(chunk);
      return true;
    };

    let caughtErr: unknown;
    try {
      await runStashShow("main", { cwd: dir });
    } catch (err) {
      caughtErr = err;
    } finally {
      process.stderr.write = origStderrWrite;
    }

    // Should exit with code 1 (via exitCode property, not a raw ENOENT)
    expect(caughtErr).toBeDefined();
    expect((caughtErr as { exitCode?: number }).exitCode).toBe(1);
    expect((caughtErr as Error).message).not.toMatch(/ENOENT/);

    // Stderr should contain the actionable message
    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).toContain("patch file not found");
    expect(stderrOutput).toContain("wt stash drop main");
  });
});
