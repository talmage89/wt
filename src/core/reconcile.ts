import { readdir, stat, rm } from "fs/promises";
import { join } from "path";
import type { State } from "./state.js";
import { writeState } from "./state.js";
import * as git from "./git.js";

/**
 * Reconcile internal state with actual git state.
 *
 * Enhanced algorithm (Phase 8.3):
 * 1. Run `git worktree list --porcelain` from .wt/repo to get all registered
 *    worktrees with their paths and branches.
 * 2. List all subdirectories of containerDir that are NOT .wt.
 * 3. Cross-reference:
 *    a. Dir exists AND in git worktree list → normal, update branch in state.
 *    b. Dir exists but NOT in git worktree list → orphaned directory;
 *       warn to stderr and remove from state.
 *    c. In git worktree list but dir missing → stale registration;
 *       run `git worktree prune` and remove from state.
 * 4. Remove state entries whose dirs no longer exist.
 * 5. Run `git worktree prune` if any stale registrations were found.
 * 6. Write and return updated state.
 *
 * This function is silent except for orphaned-directory warnings.
 */
export async function reconcile(
  wtDir: string,
  containerDir: string,
  state: State
): Promise<State> {
  const repoDir = join(wtDir, "repo");

  // Step 1: Get all registered worktrees from git
  let registeredWorktrees: Array<{ path: string; head: string; branch: string | null }> = [];
  let gitWorktreeAvailable = false;
  try {
    registeredWorktrees = await git.worktreeList(repoDir);
    gitWorktreeAvailable = true;
  } catch {
    // If git worktree list fails, fall back to directory-based reconcile only
  }

  // Build a Set of registered worktree paths (excluding the main bare repo)
  const registeredPaths = new Set<string>();
  if (gitWorktreeAvailable) {
    for (const w of registeredWorktrees) {
      // The main repo itself may appear; skip it
      if (w.path !== repoDir) {
        registeredPaths.add(w.path);
      }
    }
  }

  // Step 2: List all slot directories in containerDir
  let entries: string[];
  try {
    entries = await readdir(containerDir);
  } catch {
    return state;
  }

  const existingSlots = new Set<string>();
  for (const entry of entries) {
    if (entry === ".wt") continue;
    const fullPath = join(containerDir, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        existingSlots.add(entry);
      }
    } catch {
      // Ignore entries we can't stat
    }
  }

  // Step 3: Process each existing slot directory
  let needsPrune = false;

  for (const slotName of existingSlots) {
    const slotPath = join(containerDir, slotName);

    if (gitWorktreeAvailable && !registeredPaths.has(slotPath)) {
      // Case b: dir exists but NOT in git worktree list → orphaned directory
      process.stderr.write(
        `wt: warning: slot "${slotName}" exists on disk but is not registered as a git worktree. Removing from state.\n`
      );
      delete state.slots[slotName];
      continue;
    }

    // Check for corrupted slot: directory exists but .git file is missing.
    // This happens when someone empties a slot directory (rm -rf contents) without
    // removing the directory itself. The slot appears vacant but git operations fail.
    const dotGitPath = join(slotPath, ".git");
    let dotGitExists = false;
    try {
      await stat(dotGitPath);
      dotGitExists = true;
    } catch {
      // .git file missing
    }

    if (!dotGitExists) {
      // Corrupted slot: remove the empty directory, prune stale git worktree
      // registration, and recreate the worktree from scratch.
      try {
        await rm(slotPath, { recursive: true, force: true });
        await git.worktreePrune(repoDir);
        // Recreate the worktree as vacant (detached HEAD)
        let slotCommit: string;
        try {
          const branch = await git.defaultBranch(repoDir);
          slotCommit = (await git.refExists(repoDir, `refs/remotes/origin/${branch}`))
            ? `origin/${branch}`
            : "HEAD";
        } catch {
          slotCommit = "HEAD";
        }
        await git.worktreeAdd(repoDir, slotPath, slotCommit);
      } catch {
        // If repair fails, remove from state and skip
        delete state.slots[slotName];
        continue;
      }
      // After repair, slot is vacant
      if (!(slotName in state.slots)) {
        state.slots[slotName] = {
          branch: null,
          last_used_at: new Date(0).toISOString(),
          pinned: false,
        };
      } else {
        state.slots[slotName].branch = null;
      }
      continue;
    }

    // Case a: dir exists and is registered (or git worktree list unavailable)
    // Update branch in state to match git reality
    const actualBranch = await git.currentBranch(slotPath).catch(() => null);

    if (!(slotName in state.slots)) {
      // Newly discovered slot (e.g., created outside wt)
      state.slots[slotName] = {
        branch: actualBranch,
        last_used_at: new Date(0).toISOString(),
        pinned: false,
      };
    } else {
      // Update branch to match git reality (silent reconcile)
      state.slots[slotName].branch = actualBranch;
    }
  }

  // Step 4: Remove state entries whose directories no longer exist
  for (const slotName of Object.keys(state.slots)) {
    if (!existingSlots.has(slotName)) {
      delete state.slots[slotName];
    }
  }

  // Step 3c: Check for stale worktree registrations (registered but dir missing)
  if (gitWorktreeAvailable) {
    for (const registeredPath of registeredPaths) {
      try {
        await stat(registeredPath);
      } catch {
        // Registered path no longer exists on disk → stale registration
        needsPrune = true;
        break; // One prune call will clean all stale entries
      }
    }
  }

  // Step 5: Run git worktree prune if needed
  if (needsPrune) {
    try {
      await git.worktreePrune(repoDir);
    } catch {
      // Non-fatal: prune failure doesn't break anything
    }
  }

  await writeState(wtDir, state);
  return state;
}
