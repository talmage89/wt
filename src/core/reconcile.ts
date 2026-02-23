import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { State } from "./state.js";
import { writeState } from "./state.js";
import * as git from "./git.js";

/**
 * Reconcile internal state with actual git state.
 * For each slot directory in the container:
 *   - Detect current branch (or detached HEAD)
 *   - Update state.slots[name].branch accordingly
 *   - Preserve pinned status and LRU timestamps
 * Handles: direct `git checkout` by user, deleted worktrees, etc.
 * Returns the updated state (also writes it).
 *
 * This function is silent — no user-facing output.
 */
export async function reconcile(
  wtDir: string,
  containerDir: string,
  state: State
): Promise<State> {
  // List all entries in containerDir
  let entries: string[];
  try {
    entries = await readdir(containerDir);
  } catch {
    // If we can't read the container, return state unchanged
    return state;
  }

  // Find all slot directories (exclude .wt)
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

  // For each existing slot directory, sync branch state
  for (const slotName of existingSlots) {
    const slotPath = join(containerDir, slotName);
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

  // Remove slots whose directories no longer exist
  for (const slotName of Object.keys(state.slots)) {
    if (!existingSlots.has(slotName)) {
      delete state.slots[slotName];
    }
  }

  await writeState(wtDir, state);
  return state;
}
