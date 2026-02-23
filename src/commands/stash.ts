import path from "node:path";
import { findContainer, validateContainer, currentSlotName } from "../core/container.js";
import { readState, writeState } from "../core/state.js";
import { reconcile } from "../core/reconcile.js";
import { acquireLock } from "../core/lock.js";
import {
  listStashes,
  getStash,
  restoreStash,
  dropStash,
  showStash,
} from "../core/stash.js";
import { findSlotForBranch } from "../core/slots.js";

export interface StashOptions {
  cwd?: string;
}

/**
 * Relative time string from an ISO 8601 timestamp.
 */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * `wt stash list` — list all saved stashes.
 */
export async function runStashList(options: StashOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }
  await validateContainer(paths);

  const stashes = await listStashes(paths.wtDir);
  if (stashes.length === 0) {
    process.stdout.write("No saved stashes.\n");
    return;
  }

  // Print table header
  const branchW = 30;
  const ageW = 12;
  const statusW = 10;
  const commitW = 10;

  const header =
    "Branch".padEnd(branchW) +
    "Age".padEnd(ageW) +
    "Status".padEnd(statusW) +
    "Base Commit";
  const divider =
    "─".repeat(branchW - 2) +
    "  " +
    "─".repeat(ageW - 2) +
    "  " +
    "─".repeat(statusW - 2) +
    "  " +
    "─".repeat(commitW);

  process.stdout.write(header + "\n");
  process.stdout.write(divider + "\n");

  for (const s of stashes) {
    const branch = s.branch.length > branchW - 2 ? s.branch.slice(0, branchW - 5) + "..." : s.branch;
    const age = relativeTime(s.created_at);
    const commitShort = s.commit.slice(0, 7);
    const line =
      branch.padEnd(branchW) +
      age.padEnd(ageW) +
      s.status.padEnd(statusW) +
      commitShort;
    process.stdout.write(line + "\n");
  }
}

/**
 * Resolve the branch for stash subcommands.
 * If branch is provided, use it. Otherwise infer from cwd's slot.
 */
async function resolveBranch(
  branch: string | undefined,
  cwd: string,
  paths: { container: string; wtDir: string; repoDir: string },
  state: Awaited<ReturnType<typeof readState>>
): Promise<string> {
  if (branch) return branch;

  const slotName = currentSlotName(cwd, paths);
  if (!slotName) {
    throw new Error("Not inside a worktree slot. Specify a branch name.");
  }
  const slot = state.slots[slotName];
  if (!slot) {
    throw new Error(`Slot '${slotName}' not found in state.`);
  }
  if (!slot.branch) {
    throw new Error("Current slot is in detached HEAD state.");
  }
  return slot.branch;
}

/**
 * `wt stash apply [branch]` — apply a saved stash.
 */
export async function runStashApply(
  branch?: string,
  options: StashOptions = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }
  await validateContainer(paths);

  const release = await acquireLock(paths.wtDir);
  try {
    let state = await readState(paths.wtDir);
    state = await reconcile(paths.wtDir, paths.container, state);
    await writeState(paths.wtDir, state);

    const resolvedBranch = await resolveBranch(branch, cwd, paths, state);

    const stash = await getStash(paths.wtDir, resolvedBranch);
    if (!stash) {
      throw new Error(`No stash found for branch '${resolvedBranch}'.`);
    }
    if (stash.status === "archived") {
      throw new Error(
        `Stash for '${resolvedBranch}' is archived. Use 'wt clean' to manage archived stashes.`
      );
    }

    const slot = findSlotForBranch(state, resolvedBranch);
    if (!slot) {
      throw new Error(
        `Branch '${resolvedBranch}' is not checked out in any slot. Run 'wt checkout ${resolvedBranch}' first.`
      );
    }

    const worktreeDir = path.join(paths.container, slot);
    const result = await restoreStash(paths.wtDir, paths.repoDir, resolvedBranch, worktreeDir);

    switch (result) {
      case "restored":
        process.stdout.write(`Stash applied and cleaned up for '${resolvedBranch}'.\n`);
        break;
      case "conflict":
        process.stdout.write(
          `Stash applied with conflicts. Resolve manually, then run 'wt stash drop ${resolvedBranch}'.\n`
        );
        break;
      case "none":
        process.stdout.write(`No stash found for '${resolvedBranch}'.\n`);
        break;
    }
  } finally {
    await release();
  }
}

/**
 * `wt stash drop [branch]` — delete a saved stash without applying.
 * Prompts for confirmation.
 */
export async function runStashDrop(
  branch?: string,
  options: StashOptions & { confirmYes?: boolean } = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }
  await validateContainer(paths);

  const release = await acquireLock(paths.wtDir);
  try {
    const state = await readState(paths.wtDir);
    const resolvedBranch = await resolveBranch(branch, cwd, paths, state);

    const stash = await getStash(paths.wtDir, resolvedBranch);
    if (!stash) {
      throw new Error(`No stash found for branch '${resolvedBranch}'.`);
    }

    if (!options.confirmYes) {
      const confirmed = await promptConfirm(
        `Drop stash for '${resolvedBranch}'? This cannot be undone. [y/N] `
      );
      if (!confirmed) {
        process.stdout.write("Aborted.\n");
        return;
      }
    }

    await dropStash(paths.wtDir, paths.repoDir, resolvedBranch);
    process.stdout.write(`Stash dropped for '${resolvedBranch}'.\n`);
  } finally {
    await release();
  }
}

/**
 * `wt stash show [branch]` — display diff of a saved stash.
 */
export async function runStashShow(
  branch?: string,
  options: StashOptions = {}
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }
  await validateContainer(paths);

  const state = await readState(paths.wtDir);
  const resolvedBranch = await resolveBranch(branch, cwd, paths, state);

  const stash = await getStash(paths.wtDir, resolvedBranch);
  if (!stash) {
    throw new Error(`No stash found for branch '${resolvedBranch}'.`);
  }
  if (stash.status === "archived") {
    throw new Error(
      `Stash is archived. Cannot show diff from archived stash.`
    );
  }

  // git stash show requires a non-bare working tree — use the first available slot
  const slotNames = Object.keys(state.slots);
  if (slotNames.length === 0) {
    throw new Error("No worktree slots found.");
  }
  const worktreeDir = path.join(paths.container, slotNames[0]);

  const diff = await showStash(worktreeDir, stash.stash_ref);
  process.stdout.write(diff + "\n");
}

/**
 * Prompt the user for a yes/no confirmation on stdin.
 */
async function promptConfirm(question: string): Promise<boolean> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let answer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk: string) => {
      answer = chunk.trim().toLowerCase();
      process.stdin.pause();
      resolve(answer === "y" || answer === "yes");
    });
  });
}
