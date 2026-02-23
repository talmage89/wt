import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { readState, writeState } from "../../src/core/state.js";
import { reconcile } from "../../src/core/reconcile.js";
import { createTempDir, createTestRepo, cleanup } from "./helpers.js";

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

describe("reconcile — direct git checkout detected", () => {
  it("should update state when user bypasses wt and runs git checkout directly", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Find a slot that has 'main' checked out
    const state = await readState(wtDir);
    const slotName = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    expect(slotName).toBeDefined();

    const slotPath = path.join(containerDir, slotName);

    // Create a new branch in the bare repo and check it out directly in the slot
    await execa("git", ["branch", "direct-checkout"], { cwd: repoDir });
    await execa("git", ["checkout", "direct-checkout"], { cwd: slotPath });

    // State still says 'main' (stale)
    const staleBranch = (await readState(wtDir)).slots[slotName].branch;
    expect(staleBranch).toBe("main");

    // Reconcile should detect the change
    const freshState = await readState(wtDir);
    const updated = await reconcile(wtDir, containerDir, freshState);

    expect(updated.slots[slotName].branch).toBe("direct-checkout");

    // Persisted state should also be updated
    const persisted = await readState(wtDir);
    expect(persisted.slots[slotName].branch).toBe("direct-checkout");
  });
});

describe("reconcile — slot removed externally", () => {
  it("should remove a slot from state when its directory no longer exists", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    const state = await readState(wtDir);
    const slotNames = Object.keys(state.slots);
    expect(slotNames.length).toBeGreaterThan(0);

    // Pick any slot and delete its directory
    const targetSlot = slotNames[0];
    const slotPath = path.join(containerDir, targetSlot);

    // We need to remove the worktree from git's tracking too, otherwise
    // git won't let us delete the directory easily. Remove via git worktree remove.
    await execa("git", ["worktree", "remove", "--force", slotPath], {
      cwd: path.join(containerDir, ".wt", "repo"),
    });

    // Slot directory should be gone
    await expect(fs.access(slotPath)).rejects.toThrow();

    // Reconcile should drop the slot from state
    const freshState = await readState(wtDir);
    const updated = await reconcile(wtDir, containerDir, freshState);

    expect(targetSlot in updated.slots).toBe(false);

    // Persisted state should also reflect the removal
    const persisted = await readState(wtDir);
    expect(targetSlot in persisted.slots).toBe(false);
  });
});

describe("reconcile — new slot directory discovered", () => {
  it("should add a newly-created worktree to state", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Create a new branch and add a worktree manually (outside wt).
    // Branch already exists in the bare repo after `git branch`, so use
    // `git worktree add <path> <branch>` (no -b flag).
    await execa("git", ["branch", "outside-wt"], { cwd: repoDir });
    const newSlotPath = path.join(containerDir, "new-slot-dir");
    await execa("git", ["worktree", "add", newSlotPath, "outside-wt"], {
      cwd: repoDir,
    });

    // State should not yet know about new-slot-dir
    const freshState = await readState(wtDir);
    expect("new-slot-dir" in freshState.slots).toBe(false);

    const updated = await reconcile(wtDir, containerDir, freshState);

    expect("new-slot-dir" in updated.slots).toBe(true);
    expect(updated.slots["new-slot-dir"].branch).toBe("outside-wt");

    // Persisted state reflects discovery
    const persisted = await readState(wtDir);
    expect("new-slot-dir" in persisted.slots).toBe(true);
  });

  it("should set pinned=false and oldest last_used_at for discovered slots", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    await execa("git", ["branch", "discovered"], { cwd: repoDir });
    const newSlotPath = path.join(containerDir, "discovered-slot");
    await execa("git", ["worktree", "add", newSlotPath, "discovered"], {
      cwd: repoDir,
    });

    const freshState = await readState(wtDir);
    const updated = await reconcile(wtDir, containerDir, freshState);

    expect(updated.slots["discovered-slot"].pinned).toBe(false);
    // last_used_at should be epoch (oldest) so it gets LRU evicted first
    expect(updated.slots["discovered-slot"].last_used_at).toBe(
      new Date(0).toISOString()
    );
  });
});

describe("reconcile — detached HEAD handling", () => {
  it("should mark a slot as vacant (null branch) when HEAD is detached", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    // Find the main slot and detach its HEAD directly
    const state = await readState(wtDir);
    const slotName = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    const slotPath = path.join(containerDir, slotName);

    // Detach HEAD by checking out the current commit hash
    const { stdout: headHash } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: slotPath,
    });
    await execa("git", ["checkout", "--detach", headHash.trim()], {
      cwd: slotPath,
    });

    // Reconcile should detect the detached state
    const freshState = await readState(wtDir);
    const updated = await reconcile(wtDir, containerDir, freshState);

    expect(updated.slots[slotName].branch).toBeNull();
  });
});

describe("reconcile — preserves pinned and timestamps", () => {
  it("should preserve pinned status and last_used_at during reconcile", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    // Pin a slot and set a specific timestamp
    const state = await readState(wtDir);
    const slotName = Object.keys(state.slots)[0];
    const customTime = "2025-01-15T12:00:00.000Z";
    state.slots[slotName].pinned = true;
    state.slots[slotName].last_used_at = customTime;
    await writeState(wtDir, state);

    // Reconcile should not clobber these values
    const freshState = await readState(wtDir);
    const updated = await reconcile(wtDir, containerDir, freshState);

    expect(updated.slots[slotName].pinned).toBe(true);
    expect(updated.slots[slotName].last_used_at).toBe(customTime);
  });
});

describe("reconcile — orphaned directory (not in git worktree list)", () => {
  it("should warn and skip a plain directory that is not a registered git worktree", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    // Create a plain directory in the container — NOT a git worktree
    const orphanPath = path.join(containerDir, "orphan-slot");
    await fs.mkdir(orphanPath);

    const freshState = await readState(wtDir);
    const originalSlotCount = Object.keys(freshState.slots).length;

    const updated = await reconcile(wtDir, containerDir, freshState);

    // Orphaned dir should NOT be added to state
    expect("orphan-slot" in updated.slots).toBe(false);
    // All legitimate worktrees should still be tracked
    expect(Object.keys(updated.slots).length).toBe(originalSlotCount);
  });
});

describe("reconcile — corrupted slot (directory emptied, .git missing)", () => {
  it("should repair a slot whose directory exists but has no .git file (BUG-015)", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const state = await readState(wtDir);
    const slotNames = Object.keys(state.slots);

    // Pick a vacant slot (branch === null) to corrupt
    const vacantSlot = slotNames.find((n) => state.slots[n].branch === null)!;
    expect(vacantSlot).toBeDefined();

    const slotPath = path.join(containerDir, vacantSlot);

    // Verify the .git file exists before corruption
    await expect(fs.access(path.join(slotPath, ".git"))).resolves.toBeUndefined();

    // Empty the slot directory contents (simulates `rm -rf slot/*`)
    const entries = await fs.readdir(slotPath, { withFileTypes: true });
    for (const entry of entries) {
      await fs.rm(path.join(slotPath, entry.name), { recursive: true, force: true });
    }

    // Verify .git is gone but directory exists
    await expect(fs.access(slotPath)).resolves.toBeUndefined();
    await expect(fs.access(path.join(slotPath, ".git"))).rejects.toThrow();

    // Reconcile should detect corruption and repair the slot
    const freshState = await readState(wtDir);
    const updated = await reconcile(wtDir, containerDir, freshState);

    // Slot should still exist in state (repaired, not removed)
    expect(vacantSlot in updated.slots).toBe(true);
    // It should be vacant after repair
    expect(updated.slots[vacantSlot].branch).toBeNull();

    // The repaired slot should be a valid git worktree now
    const repairedSlotPath = path.join(containerDir, vacantSlot);
    await expect(fs.access(path.join(repairedSlotPath, ".git"))).resolves.toBeUndefined();

    // Git operations should work in the repaired slot
    const result = await execa("git", ["status"], { cwd: repairedSlotPath });
    expect(result.exitCode).toBe(0);
  });

  it("should allow checkout into a repaired slot after reconciliation", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Create a branch we can checkout
    await execa("git", ["branch", "test-repair"], { cwd: repoDir });

    const state = await readState(wtDir);
    const slotNames = Object.keys(state.slots);
    const vacantSlot = slotNames.find((n) => state.slots[n].branch === null)!;
    const slotPath = path.join(containerDir, vacantSlot);

    // Empty the slot
    const entries = await fs.readdir(slotPath, { withFileTypes: true });
    for (const entry of entries) {
      await fs.rm(path.join(slotPath, entry.name), { recursive: true, force: true });
    }

    // Reconcile repairs the slot
    const freshState = await readState(wtDir);
    await reconcile(wtDir, containerDir, freshState);

    // Now git checkout should work in the repaired slot
    await execa("git", ["checkout", "test-repair"], {
      cwd: path.join(containerDir, vacantSlot),
    });
    const { stdout } = await execa("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: path.join(containerDir, vacantSlot),
    });
    expect(stdout.trim()).toBe("test-repair");
  });
});

describe("reconcile — stale worktree registration pruned", () => {
  it("should prune and remove a slot whose directory was deleted without git worktree remove", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const state = await readState(wtDir);
    const slotName = Object.keys(state.slots)[0];
    const slotPath = path.join(containerDir, slotName);

    // Delete the directory directly (bypassing git worktree remove)
    await fs.rm(slotPath, { recursive: true, force: true });

    // Verify it's gone from disk
    await expect(fs.access(slotPath)).rejects.toThrow();

    // Before reconcile, git worktree list should still show it as registered
    const beforeWorktrees = await execa("git", ["worktree", "list"], {
      cwd: repoDir,
    });
    expect(beforeWorktrees.stdout).toContain(slotName);

    // Reconcile should remove from state and trigger git worktree prune
    const freshState = await readState(wtDir);
    const updated = await reconcile(wtDir, containerDir, freshState);

    // Slot should be removed from state
    expect(slotName in updated.slots).toBe(false);

    // After reconcile, git worktree list should no longer show the stale entry
    const afterWorktrees = await execa("git", ["worktree", "list"], {
      cwd: repoDir,
    });
    expect(afterWorktrees.stdout).not.toContain(slotName);
  });
});
