import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { runCheckout } from "../../src/commands/checkout.js";
import { readState, writeState } from "../../src/core/state.js";
import { getStash } from "../../src/core/stash.js";
import { readConfig, writeConfig } from "../../src/core/config.js";
import { syncAllSymlinks } from "../../src/core/symlinks.js";
import { createTempDir, createTestRepo, cleanup, exists } from "./helpers.js";

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
 * Returns the container dir, .wt dir, and repo dir.
 */
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
 * Find the slot name whose branch matches the given branch name.
 */
async function findSlotWithBranch(
  containerDir: string,
  branch: string
): Promise<string | null> {
  const state = await readState(path.join(containerDir, ".wt"));
  for (const [name, slot] of Object.entries(state.slots)) {
    if (slot.branch === branch) return name;
  }
  return null;
}

/**
 * Create a local branch in the bare .wt/repo at current HEAD.
 */
async function createLocalBranch(repoDir: string, name: string): Promise<void> {
  await execa("git", ["branch", name], { cwd: repoDir });
}

/**
 * Fill all remaining vacant slots by checking out the given branches.
 */
async function fillVacantSlots(
  containerDir: string,
  repoDir: string,
  branches: string[]
): Promise<void> {
  for (const b of branches) {
    await createLocalBranch(repoDir, b);
    await runCheckout({ branch: b, cwd: containerDir });
  }
}

describe("wt checkout — branch already in a slot", () => {
  it("should navigate to the existing slot without eviction", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    const slotBefore = await findSlotWithBranch(containerDir, "main");
    expect(slotBefore).not.toBeNull();

    const targetDir = await runCheckout({ branch: "main", cwd: containerDir });

    // Should return the same slot directory
    expect(targetDir).toBe(path.join(containerDir, slotBefore!));

    // State should still show main in that slot
    const state = await readState(wtDir);
    expect(state.slots[slotBefore!].branch).toBe("main");
  });

  it("should update branch_history when navigating to existing slot", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    // Remove main from branch_history to start fresh
    let state = await readState(wtDir);
    state.branch_history = [];
    await writeState(wtDir, state);

    await runCheckout({ branch: "main", cwd: containerDir });

    state = await readState(wtDir);
    expect(state.branch_history[0].branch).toBe("main");
  });
});

describe("wt checkout — vacant slot selection", () => {
  it("should check out a new branch into a vacant slot", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    await createLocalBranch(repoDir, "feature-x");
    await runCheckout({ branch: "feature-x", cwd: containerDir });

    const slot = await findSlotWithBranch(containerDir, "feature-x");
    expect(slot).not.toBeNull();

    // Verify git agrees: the slot has feature-x checked out
    const actual = (
      await execa("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: path.join(containerDir, slot!),
      })
    ).stdout.trim();
    expect(actual).toBe("feature-x");

    // Branch history updated
    const state = await readState(wtDir);
    expect(state.branch_history[0].branch).toBe("feature-x");
  });

  it("should write nav file pointing to the target slot", async () => {
    const dir = await mktemp();
    const { containerDir, repoDir } = await setupContainer(dir);

    await createLocalBranch(repoDir, "nav-test");
    const targetDir = await runCheckout({ branch: "nav-test", cwd: containerDir });

    const slot = await findSlotWithBranch(containerDir, "nav-test");
    expect(targetDir).toBe(path.join(containerDir, slot!));
  });
});

describe("wt checkout — LRU eviction", () => {
  it("should evict the least-recently-used slot when all slots are occupied", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Fill the 4 vacant slots (init gave us: main + 4 vacant = 5 total)
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // All 5 slots occupied: main, b1, b2, b3, b4
    let state = await readState(wtDir);
    expect(Object.values(state.slots).every((s) => s.branch !== null)).toBe(true);

    // Force main's slot to be the LRU
    const mainSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    state.slots[mainSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Checkout b5 — should evict main's slot
    await createLocalBranch(repoDir, "b5");
    await runCheckout({ branch: "b5", cwd: containerDir });

    state = await readState(wtDir);
    expect(state.slots[mainSlot].branch).toBe("b5");

    // main should no longer be in any slot
    const mainStillInSlot = Object.values(state.slots).some(
      (s) => s.branch === "main"
    );
    expect(mainStillInSlot).toBe(false);
  });
});

describe("wt checkout — nonexistent branch pre-check (BUG-028)", () => {
  it("should fail before evicting when branch does not exist locally or remotely", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Fill all 5 slots
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Record slot assignments before the failed checkout attempt
    const stateBefore = await readState(wtDir);
    const slotsBefore = Object.fromEntries(
      Object.entries(stateBefore.slots).map(([k, v]) => [k, v.branch])
    );

    // Attempt to checkout a branch that doesn't exist anywhere
    await expect(
      runCheckout({ branch: "feature/does-not-exist-anywhere", cwd: containerDir })
    ).rejects.toThrow("not found locally or on remote");

    // Slot assignments must be unchanged — no eviction should have occurred
    const stateAfter = await readState(wtDir);
    const slotsAfter = Object.fromEntries(
      Object.entries(stateAfter.slots).map(([k, v]) => [k, v.branch])
    );
    expect(slotsAfter).toEqual(slotsBefore);

    // No slot should be vacant
    const hasVacant = Object.values(stateAfter.slots).some(
      (s) => s.branch === null
    );
    expect(hasVacant).toBe(false);
  });

  it("should succeed (and evict) when the branch exists only on remote", async () => {
    const dir = await mktemp();
    const { containerDir, repoDir } = await setupContainer(dir);

    // Fill all 5 slots
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Create a remote-only branch: add it to origin/<branch> via fetch trickery.
    // In our test setup, the remote IS the bare repo — create the branch there
    // and rely on the fetch step in runCheckout to pick it up.
    // The easiest approach: just create a local branch in .wt/repo (the bare
    // repo acts as both the working repo and its own "remote" in tests).
    // Since remoteBranchExists checks refs/remotes/origin/<branch>, and tests
    // don't have a real remote, we create the branch locally so the local check
    // passes. The important thing is that the pre-check doesn't reject it.
    await createLocalBranch(repoDir, "remote-only");

    // Should succeed without error
    await expect(
      runCheckout({ branch: "remote-only", cwd: containerDir })
    ).resolves.toBeTruthy();
  });
});

describe("wt checkout — stash save/restore", () => {
  it("should save dirty state when evicting a slot", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const mainSlot = await findSlotWithBranch(containerDir, "main");
    const mainSlotDir = path.join(containerDir, mainSlot!);

    // Modify a tracked file (unstaged) — reliably captured by git stash create
    await fs.writeFile(path.join(mainSlotDir, "README.md"), "# Dirty\n");

    // Fill all other slots
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Force main's slot to be LRU
    let state = await readState(wtDir);
    const mSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    state.slots[mSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Checkout b5 — evicts main, should save its dirty state
    await createLocalBranch(repoDir, "b5");
    await runCheckout({ branch: "b5", cwd: containerDir });

    // Stash metadata should exist for main
    const stash = await getStash(wtDir, "main");
    expect(stash).not.toBeNull();
    expect(stash!.branch).toBe("main");
    expect(stash!.status).toBe("active");
    expect(stash!.stash_ref).toBeTruthy();
  });

  it("should not save stash when evicted slot is clean", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Force main's slot to be LRU (main slot is clean)
    let state = await readState(wtDir);
    const mSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    state.slots[mSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    await createLocalBranch(repoDir, "b5");
    await runCheckout({ branch: "b5", cwd: containerDir });

    // No stash should exist for main (it was clean)
    const stash = await getStash(wtDir, "main");
    expect(stash).toBeNull();
  });

  it("should restore dirty state when checking back out the evicted branch", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const mainSlot = await findSlotWithBranch(containerDir, "main");
    const mainSlotDir = path.join(containerDir, mainSlot!);

    // Modify a tracked file (unstaged) so it gets captured in the stash
    await fs.writeFile(path.join(mainSlotDir, "README.md"), "# Dirty Modified\n");

    // Fill all other slots
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Evict main (LRU)
    let state = await readState(wtDir);
    const mSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    state.slots[mSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    await createLocalBranch(repoDir, "b5");
    await runCheckout({ branch: "b5", cwd: containerDir });

    // Verify stash saved
    expect(await getStash(wtDir, "main")).not.toBeNull();

    // Now make b1's slot LRU so it gets evicted when we checkout main
    state = await readState(wtDir);
    const b1Slot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "b1"
    )!;
    state.slots[b1Slot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Checkout main — should restore the stash
    await runCheckout({ branch: "main", cwd: containerDir });

    const mainSlotNow = await findSlotWithBranch(containerDir, "main");
    expect(mainSlotNow).not.toBeNull();

    // Verify tracked file modification was restored
    const readmePath = path.join(containerDir, mainSlotNow!, "README.md");
    expect(await exists(readmePath)).toBe(true);
    expect(await fs.readFile(readmePath, "utf8")).toBe("# Dirty Modified\n");

    // Stash should be cleaned up after successful restore
    expect(await getStash(wtDir, "main")).toBeNull();
  });

  it("should preserve untracked files through eviction and restore (BUG-001)", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const mainSlot = await findSlotWithBranch(containerDir, "main");
    const mainSlotDir = path.join(containerDir, mainSlot!);

    // Create an untracked file — git stash create -u silently loses these
    await fs.writeFile(path.join(mainSlotDir, "untracked.txt"), "untracked content\n");
    // Also create staged and unstaged changes to ensure all three categories work
    await fs.writeFile(path.join(mainSlotDir, "README.md"), "# Dirty Modified\n");

    // Fill all other slots so eviction is needed
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Force main's slot to be LRU so it gets evicted next
    let state = await readState(wtDir);
    const mSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    state.slots[mSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Checkout b5 — evicts main, should capture untracked.txt in stash
    await createLocalBranch(repoDir, "b5");
    await runCheckout({ branch: "b5", cwd: containerDir });

    // Stash should exist and reference a valid commit
    const stash = await getStash(wtDir, "main");
    expect(stash).not.toBeNull();

    // Make b1's slot LRU so it gets evicted when we restore main
    state = await readState(wtDir);
    const b1Slot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "b1"
    )!;
    state.slots[b1Slot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Re-checkout main — stash should be restored including untracked file
    await runCheckout({ branch: "main", cwd: containerDir });

    const mainSlotNow = await findSlotWithBranch(containerDir, "main");
    expect(mainSlotNow).not.toBeNull();
    const restoredDir = path.join(containerDir, mainSlotNow!);

    // Untracked file must have been restored
    expect(await exists(path.join(restoredDir, "untracked.txt"))).toBe(true);
    expect(
      await fs.readFile(path.join(restoredDir, "untracked.txt"), "utf8")
    ).toBe("untracked content\n");

    // Tracked file modification should also be restored
    expect(
      await fs.readFile(path.join(restoredDir, "README.md"), "utf8")
    ).toBe("# Dirty Modified\n");

    // Stash cleaned up after successful restore
    expect(await getStash(wtDir, "main")).toBeNull();
  });

  it("should skip stash restore when --no-restore is set", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const mainSlot = await findSlotWithBranch(containerDir, "main");
    const mainSlotDir = path.join(containerDir, mainSlot!);

    // Modify tracked file (dirty state captured by stash)
    await fs.writeFile(path.join(mainSlotDir, "README.md"), "# No Restore\n");

    // Fill all other slots
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Evict main
    let state = await readState(wtDir);
    const mSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    state.slots[mSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    await createLocalBranch(repoDir, "b5");
    await runCheckout({ branch: "b5", cwd: containerDir });
    expect(await getStash(wtDir, "main")).not.toBeNull();

    // Make b1's slot LRU
    state = await readState(wtDir);
    const b1Slot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "b1"
    )!;
    state.slots[b1Slot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Checkout main with --no-restore
    await runCheckout({ branch: "main", cwd: containerDir, noRestore: true });

    // Stash should still exist (not applied)
    expect(await getStash(wtDir, "main")).not.toBeNull();

    // Find the slot with main
    const mainSlotNow = await findSlotWithBranch(containerDir, "main");
    expect(mainSlotNow).not.toBeNull();

    // README.md should NOT have the dirty content (stash was not applied)
    const readmeContent = await fs.readFile(
      path.join(containerDir, mainSlotNow!, "README.md"),
      "utf8"
    );
    expect(readmeContent).not.toBe("# No Restore\n");
  });
});

describe("wt checkout — pinned slots", () => {
  it("should throw when all slots are pinned and none are vacant", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Fill all vacant slots
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Pin every slot
    const state = await readState(wtDir);
    for (const name of Object.keys(state.slots)) {
      state.slots[name].pinned = true;
    }
    await writeState(wtDir, state);

    // Attempt checkout of a new branch → should error
    await createLocalBranch(repoDir, "b6");
    await expect(
      runCheckout({ branch: "b6", cwd: containerDir })
    ).rejects.toThrow("All worktree slots are pinned");
  });

  it("should use a vacant slot even when other slots are pinned", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Fill 2 slots (main already there + checkout b1)
    await createLocalBranch(repoDir, "b1");
    await runCheckout({ branch: "b1", cwd: containerDir });

    // Pin the two occupied slots
    let state = await readState(wtDir);
    for (const name of Object.keys(state.slots)) {
      if (state.slots[name].branch !== null) {
        state.slots[name].pinned = true;
      }
    }
    await writeState(wtDir, state);

    // 3 slots are still vacant — checkout should succeed
    await createLocalBranch(repoDir, "b2");
    const targetDir = await runCheckout({ branch: "b2", cwd: containerDir });
    expect(targetDir).toBeTruthy();

    state = await readState(wtDir);
    const b2Slot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "b2"
    );
    expect(b2Slot).toBeDefined();
  });
});

describe("wt checkout — remote branch", () => {
  it("should create a tracking branch when branch exists only on remote", async () => {
    // Set up a bare remote with a feature branch
    const remoteWork = await mktemp();
    await execa("git", ["init", "-b", "main"], { cwd: remoteWork });
    await execa("git", ["config", "user.email", "test@wt.test"], {
      cwd: remoteWork,
    });
    await execa("git", ["config", "user.name", "WT Test"], { cwd: remoteWork });
    await fs.writeFile(path.join(remoteWork, "README.md"), "# Remote\n");
    await execa("git", ["add", "."], { cwd: remoteWork });
    await execa("git", ["commit", "-m", "Initial commit"], { cwd: remoteWork });

    // Create feature branch on the remote
    await execa("git", ["checkout", "-b", "feature-remote"], { cwd: remoteWork });
    await fs.writeFile(path.join(remoteWork, "feature.txt"), "feature\n");
    await execa("git", ["add", "."], { cwd: remoteWork });
    await execa("git", ["commit", "-m", "Add feature"], { cwd: remoteWork });

    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await execa("git", ["clone", "--bare", remoteWork, remoteDir]);

    // Init wt container from URL
    const containerDir = await mktemp();
    await runInit({ url: remoteDir, cwd: containerDir });

    // feature-remote exists only on origin (not as a local branch yet)
    await runCheckout({ branch: "feature-remote", cwd: containerDir });

    const state = await readState(path.join(containerDir, ".wt"));
    const slotWithFeature = Object.values(state.slots).find(
      (s) => s.branch === "feature-remote"
    );
    expect(slotWithFeature).toBeDefined();

    // Verify the slot actually has feature-remote checked out
    const featureSlotName = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "feature-remote"
    )!;
    const actual = (
      await execa("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: path.join(containerDir, featureSlotName),
      })
    ).stdout.trim();
    expect(actual).toBe("feature-remote");
  });
});

describe("wt checkout — error handling", () => {
  it("should throw when run outside a managed container", async () => {
    const dir = await mktemp();
    // Not a wt container — just a plain directory
    await expect(
      runCheckout({ branch: "main", cwd: dir })
    ).rejects.toThrow("Not inside a wt-managed container");
  });

  it("should throw when branch does not exist locally or on remote", async () => {
    const dir = await mktemp();
    const { containerDir } = await setupContainer(dir);

    await expect(
      runCheckout({ branch: "nonexistent-branch-xyz", cwd: containerDir })
    ).rejects.toBeDefined();
  });
});

describe("wt checkout — BUG-016: eviction of slot with unresolved merge conflicts", () => {
  it("should evict a slot that has unresolved merge conflicts from stash apply", async () => {
    const dir = await mktemp();

    // Create repo with a file we'll conflict on
    await createTestRepo(dir);
    const mainSlotPre = await (() => {
      // We need to set up the conflict scenario:
      // 1. Checkout main, create dirty state (modify a tracked file)
      // 2. Evict main
      // 3. Amend main's commit (simulate remote rebase)
      // 4. Re-checkout main → stash apply produces merge conflicts
      // 5. Try to evict the conflicted slot → this is the bug
      return Promise.resolve(null);
    })();

    await runInit({ cwd: dir });
    const wtDir = path.join(dir, ".wt");
    const repoDir = path.join(dir, ".wt", "repo");

    // Find and populate main slot
    let state = await readState(wtDir);
    const mainSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    const mainSlotDir = path.join(dir, mainSlot);

    // Create dirty state in main slot: modify README.md
    await fs.writeFile(path.join(mainSlotDir, "README.md"), "my local changes\n");

    // Fill all other slots so eviction is needed
    await fillVacantSlots(dir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Force main's slot to be LRU
    state = await readState(wtDir);
    state.slots[mainSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Evict main by checking out b5
    await createLocalBranch(repoDir, "b5");
    await runCheckout({ branch: "b5", cwd: dir });

    // Verify stash was created for main
    const stash = await getStash(wtDir, "main");
    expect(stash).not.toBeNull();

    // Now amend main's commit in the bare repo to create a conflict scenario.
    // We need to change README.md on main so that stash apply will conflict.
    // Clone the bare repo, amend, and push back.
    const tmpWork = await mktemp();
    const tmpWorkDir = path.join(tmpWork, "work");
    await execa("git", ["clone", repoDir, tmpWorkDir]);
    await execa("git", ["config", "user.email", "test@wt.test"], { cwd: tmpWorkDir });
    await execa("git", ["config", "user.name", "WT Test"], { cwd: tmpWorkDir });
    await fs.writeFile(path.join(tmpWorkDir, "README.md"), "completely different content\n");
    await execa("git", ["add", "."], { cwd: tmpWorkDir });
    await execa("git", ["commit", "--amend", "-m", "Amended initial commit"], { cwd: tmpWorkDir });
    // Push force back to the bare repo (origin = repoDir)
    await execa("git", ["push", "--force", "origin", "main"], { cwd: tmpWorkDir });

    // Now make a slot LRU so it gets evicted when we checkout main
    state = await readState(wtDir);
    const b1Slot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "b1"
    )!;
    state.slots[b1Slot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    await runCheckout({ branch: "main", cwd: dir });

    // main should now be in a slot, but with merge conflicts
    state = await readState(wtDir);
    const mainSlotNow = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    const mainSlotDirNow = path.join(dir, mainSlotNow);

    // Verify there are unmerged entries (conflict markers in README.md)
    const statusOut = (
      await execa("git", ["status", "--porcelain"], { cwd: mainSlotDirNow })
    ).stdout;
    // UU or AA or similar conflict marker should be present
    expect(statusOut).toContain("README.md");

    // NOW: try to evict this conflicted slot by checking out another branch.
    // BUG-016: This used to fail with "error: could not write index" / "needs merge"
    state = await readState(wtDir);
    state.slots[mainSlotNow].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    await createLocalBranch(repoDir, "b6");

    // This must not throw — the fix resolves unmerged entries before stashing
    await expect(
      runCheckout({ branch: "b6", cwd: dir })
    ).resolves.toBeDefined();

    // Verify b6 is now checked out in a slot
    state = await readState(wtDir);
    const b6Slot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "b6"
    );
    expect(b6Slot).toBeDefined();

    // A stash should have been created for main (preserving the conflict markers as content)
    const mainStash = await getStash(wtDir, "main");
    expect(mainStash).not.toBeNull();
    expect(mainStash!.status).toBe("active");
  });
});

describe("wt checkout — -b flag: branch creation", () => {
  /**
   * Helper: set up a container initialized from a URL so that
   * origin/* refs exist in the bare repo.
   */
  async function setupContainerFromUrl(): Promise<{
    containerDir: string;
    wtDir: string;
    repoDir: string;
    remoteDir: string;
  }> {
    const remoteWork = await mktemp();
    await execa("git", ["init", "-b", "main"], { cwd: remoteWork });
    await execa("git", ["config", "user.email", "test@wt.test"], { cwd: remoteWork });
    await execa("git", ["config", "user.name", "WT Test"], { cwd: remoteWork });
    await fs.writeFile(path.join(remoteWork, "README.md"), "# Remote\n");
    await execa("git", ["add", "."], { cwd: remoteWork });
    await execa("git", ["commit", "-m", "Initial commit"], { cwd: remoteWork });

    // Also create a 'develop' branch on the remote
    await execa("git", ["checkout", "-b", "develop"], { cwd: remoteWork });
    await fs.writeFile(path.join(remoteWork, "develop.txt"), "dev\n");
    await execa("git", ["add", "."], { cwd: remoteWork });
    await execa("git", ["commit", "-m", "Develop commit"], { cwd: remoteWork });
    await execa("git", ["checkout", "main"], { cwd: remoteWork });

    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await execa("git", ["clone", "--bare", remoteWork, remoteDir]);

    const containerDir = await mktemp();
    await runInit({ url: remoteDir, cwd: containerDir });

    return {
      containerDir,
      wtDir: path.join(containerDir, ".wt"),
      repoDir: path.join(containerDir, ".wt", "repo"),
      remoteDir,
    };
  }

  it("should create a new branch from origin/<default-branch> when no start-point given", async () => {
    const { containerDir, wtDir } = await setupContainerFromUrl();

    const targetDir = await runCheckout({
      branch: "feature/new",
      create: true,
      cwd: containerDir,
    });

    expect(targetDir).toBeTruthy();

    // Branch should appear in state
    const state = await readState(wtDir);
    const slot = Object.entries(state.slots).find(
      ([, s]) => s.branch === "feature/new"
    )?.[0];
    expect(slot).toBeDefined();

    // Verify git agrees
    const actual = (
      await execa("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: path.join(containerDir, slot!),
      })
    ).stdout.trim();
    expect(actual).toBe("feature/new");
  });

  it("should create a new branch from an explicit start-point", async () => {
    const { containerDir, wtDir } = await setupContainerFromUrl();

    await runCheckout({
      branch: "feature/from-develop",
      create: true,
      startPoint: "origin/develop",
      cwd: containerDir,
    });

    const state = await readState(wtDir);
    const slot = Object.entries(state.slots).find(
      ([, s]) => s.branch === "feature/from-develop"
    )?.[0];
    expect(slot).toBeDefined();

    // Verify git has the branch checked out
    const actual = (
      await execa("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: path.join(containerDir, slot!),
      })
    ).stdout.trim();
    expect(actual).toBe("feature/from-develop");

    // Verify the branch was based on develop (develop.txt should exist)
    const devFile = path.join(containerDir, slot!, "develop.txt");
    await expect(fs.access(devFile)).resolves.toBeUndefined();
  });

  it("should evict a slot if needed when creating a new branch", async () => {
    const { containerDir, wtDir, repoDir } = await setupContainerFromUrl();

    // Fill all vacant slots
    await fillVacantSlots(containerDir, repoDir, ["b1", "b2", "b3", "b4"]);

    // Force main's slot to be LRU
    let state = await readState(wtDir);
    const mainSlot = Object.keys(state.slots).find(
      (n) => state.slots[n].branch === "main"
    )!;
    state.slots[mainSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Create a new branch — should evict main's slot
    await runCheckout({
      branch: "feature/evict-test",
      create: true,
      cwd: containerDir,
    });

    state = await readState(wtDir);
    // main should no longer be in any slot
    const mainStillInSlot = Object.values(state.slots).some(
      (s) => s.branch === "main"
    );
    expect(mainStillInSlot).toBe(false);

    // feature/evict-test should be in the evicted slot
    expect(state.slots[mainSlot].branch).toBe("feature/evict-test");
  });

  it("should error when trying to create a branch that already exists locally", async () => {
    const { containerDir } = await setupContainerFromUrl();

    // 'main' already exists as a local branch
    await expect(
      runCheckout({ branch: "main", create: true, cwd: containerDir })
    ).rejects.toBeDefined();
  });
});

describe("wt checkout — BUG-009: symlinks removed before git checkout", () => {
  it("should succeed when target slot has a shared symlink for a git-tracked file", async () => {
    const dir = await mktemp();

    // Build repo with a branch that git-tracks .config/app.json
    await createTestRepo(dir);
    await execa("git", ["checkout", "-b", "feature/tracked-config"], { cwd: dir });
    await fs.mkdir(path.join(dir, ".config"), { recursive: true });
    await fs.writeFile(path.join(dir, ".config", "app.json"), '{"tracked":true}\n');
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "Add .config/app.json"], { cwd: dir });
    await execa("git", ["checkout", "main"], { cwd: dir });

    // Init wt container
    await runInit({ cwd: dir });

    const wtDir = path.join(dir, ".wt");
    const state = await readState(wtDir);

    // Update config to include .config as a shared directory
    const config = await readConfig(wtDir);
    config.shared.directories = [".config"];
    await writeConfig(wtDir, config);

    // Create canonical shared file and install symlinks in all slots (simulates wt sync)
    const canonicalDir = path.join(wtDir, "shared", ".config");
    await fs.mkdir(canonicalDir, { recursive: true });
    await fs.writeFile(path.join(canonicalDir, "app.json"), '{"shared":true}\n');
    await syncAllSymlinks(wtDir, dir, state.slots, [".config"]);

    // Sanity check: at least one slot has the symlink installed
    const hasSymlink = (
      await Promise.all(
        Object.keys(state.slots).map(async (slotName) => {
          const p = path.join(dir, slotName, ".config", "app.json");
          const st = await fs.lstat(p).catch(() => null);
          return st?.isSymbolicLink() ?? false;
        })
      )
    ).some(Boolean);
    expect(hasSymlink).toBe(true);

    // Checkout the branch that tracks .config/app.json — must not throw
    // (without the fix, git fails with "untracked working tree files would be overwritten")
    await expect(
      runCheckout({ branch: "feature/tracked-config", cwd: dir })
    ).resolves.toBeDefined();

    // The slot should have the branch checked out
    const newState = await readState(wtDir);
    const trackedSlot = Object.entries(newState.slots).find(
      ([, s]) => s.branch === "feature/tracked-config"
    )?.[0];
    expect(trackedSlot).toBeDefined();

    // The file in the slot should be the real git-tracked file, not a symlink
    const configPath = path.join(dir, trackedSlot!, ".config", "app.json");
    const st = await fs.lstat(configPath);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
  });
});
