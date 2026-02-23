import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { runCheckout } from "../../src/commands/checkout.js";
import { readState, writeState } from "../../src/core/state.js";
import { getStash } from "../../src/core/stash.js";
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
