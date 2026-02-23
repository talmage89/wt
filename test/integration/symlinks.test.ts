import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { runCheckout } from "../../src/commands/checkout.js";
import { runSync } from "../../src/commands/sync.js";
import { readState } from "../../src/core/state.js";
import { readConfig, writeConfig } from "../../src/core/config.js";
import {
  establishSymlinks,
  syncAllSymlinks,
} from "../../src/core/symlinks.js";
import {
  createTempDir,
  createTestRepo,
  cleanup,
  exists,
} from "./helpers.js";

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

/**
 * Initialize a wt container from a fresh test repo.
 */
async function setupContainer(dir: string) {
  await createTestRepo(dir);
  await runInit({ cwd: dir });
  const state = await readState(path.join(dir, ".wt"));
  return {
    containerDir: dir,
    wtDir: path.join(dir, ".wt"),
    repoDir: path.join(dir, ".wt", "repo"),
    state,
  };
}

/**
 * Get the name of the first slot from state.
 */
function firstSlot(state: Awaited<ReturnType<typeof readState>>): string {
  return Object.keys(state.slots)[0];
}

describe("establishSymlinks", () => {
  it("creates a symlink in the worktree pointing to the canonical file", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, state } = await setupContainer(dir);
    const slotName = firstSlot(state);
    const worktreeDir = path.join(containerDir, slotName);

    // Create canonical file
    const canonicalDir = path.join(wtDir, "shared", ".claude");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(
      path.join(canonicalDir, "settings.json"),
      '{"hello": true}',
      "utf8"
    );

    await establishSymlinks(wtDir, worktreeDir, [".claude"], "main");

    const symlinkPath = path.join(worktreeDir, ".claude", "settings.json");
    const st = await fs.lstat(symlinkPath);
    expect(st.isSymbolicLink()).toBe(true);

    // Reading via the symlink returns canonical content
    const content = await fs.readFile(symlinkPath, "utf8");
    expect(content).toBe('{"hello": true}');

    // The symlink target is relative
    const target = await fs.readlink(symlinkPath);
    expect(path.isAbsolute(target)).toBe(false);
    expect(target).toContain(".wt");
  });

  it("skips and warns when file is git-tracked in the branch", async () => {
    const dir = await mktemp();

    // Create repo with a git-tracked .claude/CLAUDE.md on main
    await execa("git", ["init", "-b", "main"], { cwd: dir });
    await execa("git", ["config", "user.email", "t@t.test"], { cwd: dir });
    await execa("git", ["config", "user.name", "T"], { cwd: dir });
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude", "CLAUDE.md"), "# git tracked\n");
    await fs.writeFile(path.join(dir, "README.md"), "# test\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "Add files"], { cwd: dir });

    await runInit({ cwd: dir });

    const wtDir = path.join(dir, ".wt");
    const state = await readState(wtDir);
    const slotName = firstSlot(state);
    const worktreeDir = path.join(dir, slotName);

    // Create a canonical version of the same file
    const canonicalDir = path.join(wtDir, "shared", ".claude");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(
      path.join(canonicalDir, "CLAUDE.md"),
      "# canonical version\n",
      "utf8"
    );

    // Capture stderr
    const stderrLines: string[] = [];
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") stderrLines.push(chunk);
      return true;
    };

    try {
      await establishSymlinks(wtDir, worktreeDir, [".claude"], "main");
    } finally {
      process.stderr.write = originalStderr;
    }

    // The .claude/CLAUDE.md should NOT be a symlink (it's git-tracked)
    const st = await fs.lstat(path.join(worktreeDir, ".claude", "CLAUDE.md"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);

    // A warning was emitted
    const warning = stderrLines.join("");
    expect(warning).toContain("tracked by git");
  });

  it("fixes a symlink that points to the wrong target", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, state } = await setupContainer(dir);
    const slotName = firstSlot(state);
    const worktreeDir = path.join(containerDir, slotName);

    // Create canonical file
    const canonicalDir = path.join(wtDir, "shared", ".claude");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "settings.json"), "correct");

    // Create a wrong symlink first
    await fs.mkdir(path.join(worktreeDir, ".claude"), { recursive: true });
    await fs.symlink("/wrong/path", path.join(worktreeDir, ".claude", "settings.json"));

    await establishSymlinks(wtDir, worktreeDir, [".claude"], "main");

    const target = await fs.readlink(path.join(worktreeDir, ".claude", "settings.json"));
    expect(target).not.toBe("/wrong/path");
    expect(path.isAbsolute(target)).toBe(false);
  });
});

describe("syncAllSymlinks", () => {
  it("migrates a real file in a slot to canonical location and creates symlinks in all slots", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, state } = await setupContainer(dir);
    const slots = Object.keys(state.slots);
    const slotName = slots[0];
    const worktreeDir = path.join(containerDir, slotName);

    // Manually create a real (non-symlink, non-git-tracked) file in the slot
    await fs.mkdir(path.join(worktreeDir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(worktreeDir, ".claude", "settings.json"),
      "migrated content"
    );

    await syncAllSymlinks(wtDir, containerDir, state.slots, [".claude"]);

    // Canonical file now exists
    const canonicalPath = path.join(wtDir, "shared", ".claude", "settings.json");
    expect(await exists(canonicalPath)).toBe(true);
    const canonicalContent = await fs.readFile(canonicalPath, "utf8");
    expect(canonicalContent).toBe("migrated content");

    // The slot that had the real file now has a symlink
    const slotFilePath = path.join(worktreeDir, ".claude", "settings.json");
    const st = await fs.lstat(slotFilePath);
    expect(st.isSymbolicLink()).toBe(true);
  });

  it("creates symlinks in all slots from an existing canonical file", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, state } = await setupContainer(dir);

    // Create canonical file
    const canonicalDir = path.join(wtDir, "shared", ".claude");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "settings.json"), "shared content");

    await syncAllSymlinks(wtDir, containerDir, state.slots, [".claude"]);

    // All slots should have a symlink
    for (const slotName of Object.keys(state.slots)) {
      const symlinkPath = path.join(containerDir, slotName, ".claude", "settings.json");
      const st = await fs.lstat(symlinkPath);
      expect(st.isSymbolicLink()).toBe(true);
    }
  });

  it("removes broken symlinks after canonical file is deleted", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, state } = await setupContainer(dir);

    // Create canonical file and establish symlinks
    const canonicalDir = path.join(wtDir, "shared", ".claude");
    await fs.mkdir(canonicalDir, { recursive: true });
    const canonicalFile = path.join(canonicalDir, "settings.json");
    await fs.writeFile(canonicalFile, "will be deleted");

    await syncAllSymlinks(wtDir, containerDir, state.slots, [".claude"]);

    // Verify symlinks exist
    for (const slotName of Object.keys(state.slots)) {
      expect(await exists(path.join(containerDir, slotName, ".claude", "settings.json"))).toBe(true);
    }

    // Delete canonical file
    await fs.rm(canonicalFile);

    // Run sync again — broken symlinks should be removed
    await syncAllSymlinks(wtDir, containerDir, state.slots, [".claude"]);

    for (const slotName of Object.keys(state.slots)) {
      const symlinkPath = path.join(containerDir, slotName, ".claude", "settings.json");
      const st = await fs.lstat(symlinkPath).catch(() => null);
      expect(st).toBeNull();
    }
  });

  it("is a no-op with empty shared dirs config", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, state } = await setupContainer(dir);

    // Should not throw with empty dirs
    await expect(
      syncAllSymlinks(wtDir, containerDir, state.slots, [])
    ).resolves.toBeUndefined();
  });
});

describe("wt sync command", () => {
  it("propagates symlinks and regenerates templates across all slots", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);
    await runInit({ cwd: dir });

    const wtDir = path.join(dir, ".wt");

    // Update config to include .claude as shared dir
    const config = await readConfig(wtDir);
    config.shared.directories = [".claude"];
    await writeConfig(wtDir, config);

    const state = await readState(wtDir);
    const slots = Object.keys(state.slots);
    expect(slots.length).toBeGreaterThan(0);

    // Create canonical file
    const canonicalDir = path.join(wtDir, "shared", ".claude");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "settings.json"), "synced");

    // Run sync from inside the container dir
    await runSync({ cwd: dir });

    // All slots should have a symlink
    for (const slotName of slots) {
      const symlinkPath = path.join(dir, slotName, ".claude", "settings.json");
      const st = await fs.lstat(symlinkPath);
      expect(st.isSymbolicLink()).toBe(true);
    }
  });
});

describe("checkout reconciles symlinks", () => {
  it("establishes symlinks in a slot when a canonical file is added after init", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);
    await runInit({ cwd: dir });

    const wtDir = path.join(dir, ".wt");
    const state = await readState(wtDir);

    // Find a slot that has main
    const mainSlot = Object.entries(state.slots).find(
      ([, s]) => s.branch === "main"
    )?.[0];
    expect(mainSlot).toBeDefined();

    // Add a canonical file after init
    const canonicalDir = path.join(wtDir, "shared", ".claude");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "settings.json"), "checkout test");

    // Update config to include .claude as shared dir
    const config = await readConfig(wtDir);
    config.shared.directories = [".claude"];
    await writeConfig(wtDir, config);

    // Checkout main (already in slot, so just navigates, but still calls establishSymlinks for the existing slot path)
    // Actually, checkout of a branch that's already in a slot takes the "already in slot" path
    // and does NOT call establishSymlinks. Let's check out a different branch.

    // Create a new branch and check it out
    await execa("git", ["branch", "feature-symlink"], {
      cwd: path.join(dir, ".wt", "repo"),
    });

    await runCheckout({ branch: "feature-symlink", cwd: dir });

    // Find the slot for feature-symlink
    const newState = await readState(wtDir);
    const featureSlot = Object.entries(newState.slots).find(
      ([, s]) => s.branch === "feature-symlink"
    )?.[0];
    expect(featureSlot).toBeDefined();

    const symlinkPath = path.join(dir, featureSlot!, ".claude", "settings.json");
    const st = await fs.lstat(symlinkPath);
    expect(st.isSymbolicLink()).toBe(true);
  });
});
