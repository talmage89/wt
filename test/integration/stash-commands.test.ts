import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { runCheckout } from "../../src/commands/checkout.js";
import {
  runStashList,
  runStashApply,
  runStashDrop,
  runStashShow,
} from "../../src/commands/stash.js";
import { readState, writeState } from "../../src/core/state.js";
import { getStash } from "../../src/core/stash.js";
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

/**
 * Fill all slots and create a stash for 'main' by evicting it.
 * Uses a tracked file modification so git stash create captures the dirty state.
 * Forces main to be LRU so it's the one evicted.
 */
async function createStashViaEviction(
  containerDir: string,
  wtDir: string,
  repoDir: string
): Promise<{ mainSlotName: string }> {
  let state = await readState(wtDir);
  const slotNames = Object.keys(state.slots);
  const mainSlotName = Object.entries(state.slots).find(
    ([, s]) => s.branch === "main"
  )?.[0];
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
    const fill0Slot = Object.entries(state.slots).find(
      ([, s]) => s.branch === "fill-0"
    )?.[0]!;
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
    const mainSlotNew = Object.entries(state.slots).find(
      ([, s]) => s.branch === "main"
    )?.[0]!;
    const content = await fs.readFile(
      path.join(dir, mainSlotNew, "README.md"),
      "utf8"
    );
    expect(content).toBe("# Modified for stash test\n");
  });

  it("throws when branch is not checked out in any slot", async () => {
    const dir = await mktemp();
    const { wtDir, repoDir } = await setupContainer(dir);

    await createStashViaEviction(dir, wtDir, repoDir);

    // 'main' has a stash but is NOT in any slot currently
    await expect(runStashApply("main", { cwd: dir })).rejects.toThrow(
      "not checked out"
    );
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
      runStashDrop("nonexistent-branch", { cwd: dir, confirmYes: true })
    ).rejects.toThrow("No stash found");
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

    await expect(
      runStashShow("no-such-branch", { cwd: dir })
    ).rejects.toThrow("No stash found");
  });
});
