import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "../../src/commands/init.js";
import { readState } from "../../src/core/state.js";
import { readConfig } from "../../src/core/config.js";
import * as git from "../../src/core/git.js";
import { execa } from "execa";
import {
  createTempDir,
  createTestRepo,
  createBareRemote,
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

describe("wt init (from existing repo)", () => {
  it("should create the .wt/ directory structure", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });

    expect(await exists(path.join(dir, ".wt"))).toBe(true);
    expect(await exists(path.join(dir, ".wt", "repo"))).toBe(true);
    expect(await exists(path.join(dir, ".wt", "stashes"))).toBe(true);
    expect(await exists(path.join(dir, ".wt", "stashes", "archive"))).toBe(true);
    expect(await exists(path.join(dir, ".wt", "shared"))).toBe(true);
    expect(await exists(path.join(dir, ".wt", "templates"))).toBe(true);
    expect(await exists(path.join(dir, ".wt", "hooks"))).toBe(true);
  });

  it("should create N worktree slots as directories", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });

    const config = await readConfig(path.join(dir, ".wt"));
    const entries = await fs.readdir(dir);
    const slots = entries.filter((e) => e !== ".wt");
    expect(slots.length).toBe(config.slot_count);
  });

  it("should check out the starting branch in slot 0", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });

    const state = await readState(path.join(dir, ".wt"));
    const slotNames = Object.keys(state.slots);
    expect(slotNames.length).toBeGreaterThan(0);

    // Exactly one slot should have the 'main' branch
    const mainSlots = slotNames.filter((n) => state.slots[n].branch === "main");
    expect(mainSlots.length).toBe(1);
  });

  it("should leave all other slots as vacant (detached HEAD)", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });

    const state = await readState(path.join(dir, ".wt"));
    const slotNames = Object.keys(state.slots);
    const vacantSlots = slotNames.filter((n) => state.slots[n].branch === null);
    expect(vacantSlots.length).toBe(slotNames.length - 1);
  });

  it("should write state.toml and config.toml", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });

    expect(await exists(path.join(dir, ".wt", "state.toml"))).toBe(true);
    expect(await exists(path.join(dir, ".wt", "config.toml"))).toBe(true);
  });

  it("should record the starting branch in branch_history", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });

    const state = await readState(path.join(dir, ".wt"));
    expect(state.branch_history.length).toBeGreaterThan(0);
    expect(state.branch_history[0].branch).toBe("main");
  });

  it("should preserve dirty state (unstaged tracked changes) in the active slot", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    // Modify a tracked file without staging (dirty state that git stash create captures)
    await fs.writeFile(path.join(dir, "README.md"), "# Modified\n");

    await runInit({ cwd: dir });

    const state = await readState(path.join(dir, ".wt"));
    const activeSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch !== null
    )!;

    const readmePath = path.join(dir, activeSlot, "README.md");
    expect(await exists(readmePath)).toBe(true);
    const content = await fs.readFile(readmePath, "utf8");
    expect(content).toBe("# Modified\n");
  });

  it("should remove original working tree files from container root", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    // README.md was committed to the repo
    expect(await exists(path.join(dir, "README.md"))).toBe(true);

    await runInit({ cwd: dir });

    // After init, README.md should no longer be at the container root
    expect(await exists(path.join(dir, "README.md"))).toBe(false);
    // But it should exist in the active slot
    const state = await readState(path.join(dir, ".wt"));
    const activeSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch !== null
    )!;
    expect(await exists(path.join(dir, activeSlot, "README.md"))).toBe(true);
  });

  it("should error if already initialized", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });
    await expect(runInit({ cwd: dir })).rejects.toThrow(
      "already a wt-managed container"
    );
  });

  it("should error if not a git repository", async () => {
    const dir = await mktemp();
    // No git init — plain empty directory

    await expect(runInit({ cwd: dir })).rejects.toThrow(
      "Not at the root of a git repository"
    );
  });

  it("should reject a repo with no commits without corrupting it (BUG-023)", async () => {
    const dir = await mktemp();
    // git init but NO commits — unborn HEAD
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@wt.test"], { cwd: dir });
    await execa("git", ["config", "user.name", "WT Test"], { cwd: dir });

    // Must throw a clear error
    await expect(runInit({ cwd: dir })).rejects.toThrow(
      "Repository has no commits"
    );

    // .wt/ must NOT have been created — no state changes
    expect(await exists(path.join(dir, ".wt"))).toBe(false);

    // .git/ must still be present (repo not corrupted)
    expect(await exists(path.join(dir, ".git"))).toBe(true);
    const gitStat = await fs.stat(path.join(dir, ".git"));
    expect(gitStat.isDirectory()).toBe(true);
  });

  it("should give a clear error when run from a subdirectory of a git repo (BUG-022)", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);
    const subdir = path.join(dir, "src");
    await fs.mkdir(subdir, { recursive: true });

    await expect(runInit({ cwd: subdir })).rejects.toThrow(
      "Not at the root of a git repository"
    );
  });

  it("should error (not corrupt) when run from inside a worktree slot (BUG-017)", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);
    await runInit({ cwd: dir });

    // Find a slot directory (any entry that is not .wt)
    const entries = await fs.readdir(dir);
    const slotName = entries.find((e) => e !== ".wt")!;
    const slotDir = path.join(dir, slotName);

    // A slot has a .git FILE (worktree link), not a .git/ directory
    const gitFile = path.join(slotDir, ".git");
    const gitStat = await fs.stat(gitFile);
    expect(gitStat.isFile()).toBe(true);

    // Running wt init from inside a slot must throw a clear error
    await expect(runInit({ cwd: slotDir })).rejects.toThrow(
      "not inside a worktree slot"
    );

    // The slot must not be corrupted: .git file still present and is a file
    const gitStatAfter = await fs.stat(gitFile);
    expect(gitStatAfter.isFile()).toBe(true);
  });
});

describe("wt init <url> (from URL)", () => {
  it("should create a bare clone at .wt/repo/", async () => {
    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await createBareRemote(remoteDir);

    const dir = await mktemp();
    await runInit({ url: remoteDir, cwd: dir });

    // .wt/repo/ should exist and be a bare git repo
    const repoDir = path.join(dir, ".wt", "repo");
    expect(await exists(repoDir)).toBe(true);

    // A bare repo has HEAD, config, etc. at the root (no .git subdir)
    expect(await exists(path.join(repoDir, "HEAD"))).toBe(true);
    expect(await exists(path.join(repoDir, "config"))).toBe(true);
  });

  it("should create N worktree slots", async () => {
    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await createBareRemote(remoteDir);

    const dir = await mktemp();
    await runInit({ url: remoteDir, cwd: dir });

    const config = await readConfig(path.join(dir, ".wt"));
    const entries = await fs.readdir(dir);
    const slots = entries.filter((e) => e !== ".wt");
    expect(slots.length).toBe(config.slot_count);
  });

  it("should check out the default branch in slot 0", async () => {
    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await createBareRemote(remoteDir);

    const dir = await mktemp();
    await runInit({ url: remoteDir, cwd: dir });

    const state = await readState(path.join(dir, ".wt"));
    const activeSlots = Object.values(state.slots).filter(
      (s) => s.branch !== null
    );
    expect(activeSlots.length).toBe(1);
    expect(activeSlots[0].branch).toBe("main");
  });

  it("should error if target directory is not empty", async () => {
    const dir = await mktemp();
    // Put a file in the directory
    await fs.writeFile(path.join(dir, "existing.txt"), "content");

    await expect(
      runInit({ url: "file:///nonexistent", cwd: dir })
    ).rejects.toThrow("not empty");
  });

  it("should detect non-main/master default branch (BUG-012)", async () => {
    // Create a remote repo with "develop" as the default branch
    const workDir = await mktemp();
    await execa("git", ["init", "-b", "develop"], { cwd: workDir });
    await execa("git", ["config", "user.email", "test@wt.test"], { cwd: workDir });
    await execa("git", ["config", "user.name", "WT Test"], { cwd: workDir });
    await fs.writeFile(path.join(workDir, "README.md"), "# Develop\n");
    await execa("git", ["add", "."], { cwd: workDir });
    await execa("git", ["commit", "-m", "Initial commit on develop"], { cwd: workDir });

    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await execa("git", ["clone", "--bare", workDir, remoteDir]);
    await cleanup(workDir);

    // Init from this remote — should detect "develop" as the default branch
    const dir = await mktemp();
    await runInit({ url: remoteDir, cwd: dir });

    const state = await readState(path.join(dir, ".wt"));
    const activeSlots = Object.values(state.slots).filter(
      (s) => s.branch !== null
    );
    expect(activeSlots.length).toBe(1);
    expect(activeSlots[0].branch).toBe("develop");
  });
});

describe("wt init — .wt/repo/ is a valid git repo", () => {
  it("should be able to list worktrees from .wt/repo/", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);

    await runInit({ cwd: dir });

    const repoDir = path.join(dir, ".wt", "repo");
    const worktrees = await git.worktreeList(repoDir);

    // git worktree list includes the bare repo itself as entry 0, plus
    // one entry per slot. So total = slot_count + 1.
    const config = await readConfig(path.join(dir, ".wt"));
    const slotWorktrees = worktrees.filter((w) => w.path !== repoDir);
    expect(slotWorktrees.length).toBe(config.slot_count);
  });
});
