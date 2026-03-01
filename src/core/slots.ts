import { join } from "node:path";
import type { Config } from "./config.js";
import {
  cleanUntracked,
  defaultBranch,
  hardReset,
  refExists,
  worktreeAdd,
  worktreeRemove,
} from "./git.js";
import { saveStash } from "./stash.js";
import type { SlotState, State } from "./state.js";
import { writeState } from "./state.js";
import { establishSymlinks } from "./symlinks.js";
import { generateTemplates } from "./templates.js";
import { generateSlotName } from "./words.js";

/**
 * Create N worktree slots in the container directory.
 * Each slot: `git worktree add --detach <slotPath> <commit>`
 * Returns the names of created slots.
 */
export async function createSlots(
  repoDir: string,
  containerDir: string,
  count: number,
  commit: string,
  existingSlotNames: Set<string>,
): Promise<string[]> {
  const names: string[] = [];
  const allNames = new Set(existingSlotNames);

  for (let i = 0; i < count; i++) {
    const name = generateSlotName(allNames);
    allNames.add(name);
    names.push(name);
    const slotPath = join(containerDir, name);
    await worktreeAdd(repoDir, slotPath, commit);
  }

  return names;
}

/**
 * Find the slot that has the given branch checked out.
 * Returns slot name or null.
 */
export function findSlotForBranch(state: State, branch: string): string | null {
  for (const [name, slot] of Object.entries(state.slots)) {
    if (slot.branch === branch) {
      return name;
    }
  }
  return null;
}

/**
 * Check if a slot is vacant (detached HEAD, no branch assigned).
 */
export function isVacant(slot: SlotState): boolean {
  return slot.branch === null;
}

/**
 * Select a slot for checking out a new branch.
 * Priority: (a) vacant → (b) LRU unpinned → (c) error if all pinned.
 * Returns the slot name.
 */
export function selectSlotForCheckout(state: State): string {
  const entries = Object.entries(state.slots);

  // (a) Prefer vacant slots
  for (const [name, slot] of entries) {
    if (isVacant(slot)) {
      return name;
    }
  }

  // (b) LRU among non-pinned slots
  const unpinned = entries.filter(([, slot]) => !slot.pinned);
  if (unpinned.length === 0) {
    throw new Error(
      "All worktree slots are pinned. Unpin a worktree or increase the slot count to continue.",
    );
  }

  // Sort by last_used_at ascending (oldest first)
  unpinned.sort(
    ([, a], [, b]) => new Date(a.last_used_at).getTime() - new Date(b.last_used_at).getTime(),
  );

  return unpinned[0][0];
}

/**
 * Mark a slot as used with a branch. Updates LRU timestamp.
 */
export function markSlotUsed(state: State, slotName: string, branch: string): void {
  const slot = state.slots[slotName];
  if (!slot) {
    throw new Error(`Slot not found: ${slotName}`);
  }
  slot.branch = branch;
  slot.last_used_at = new Date().toISOString();
}

/**
 * Mark a slot as vacant (after eviction/detach).
 */
export function markSlotVacant(state: State, slotName: string): void {
  const slot = state.slots[slotName];
  if (!slot) {
    throw new Error(`Slot not found: ${slotName}`);
  }
  slot.branch = null;
}

/**
 * Adjust slot count to match the configured value.
 * - Increasing: create new vacant slots with templates + symlinks.
 * - Decreasing: evict excess slots (LRU order), error if pinned > new count.
 */
export async function adjustSlotCount(
  repoDir: string,
  containerDir: string,
  wtDir: string,
  state: State,
  config: Config,
): Promise<State> {
  const currentCount = Object.keys(state.slots).length;
  const targetCount = config.slot_count;

  if (targetCount < 1) {
    throw new Error(`slot_count must be at least 1.`);
  }

  if (currentCount === targetCount) return state;

  if (targetCount > currentCount) {
    // Increasing: create new vacant slots
    const newCount = targetCount - currentCount;
    const existingNames = new Set(Object.keys(state.slots));

    // Resolve commit ref for new slots (prefer origin/<default> if it exists, fallback to HEAD)
    let slotCommit: string;
    try {
      const branch = await defaultBranch(repoDir);
      const remoteRef = `refs/remotes/origin/${branch}`;
      slotCommit = (await refExists(repoDir, remoteRef)) ? `origin/${branch}` : "HEAD";
    } catch {
      slotCommit = "HEAD";
    }

    const newNames = await createSlots(repoDir, containerDir, newCount, slotCommit, existingNames);
    const now = new Date().toISOString();

    for (const name of newNames) {
      state.slots[name] = { branch: null, last_used_at: now, pinned: false };
    }

    // Generate templates and symlinks for each new slot (vacant)
    for (const name of newNames) {
      const slotDir = join(containerDir, name);
      await generateTemplates(wtDir, slotDir, name, "", config.templates);
      await establishSymlinks(wtDir, slotDir, config.shared, "");
    }

    await writeState(wtDir, state);
  } else {
    // Decreasing: remove excess slots
    const excessCount = currentCount - targetCount;
    const pinnedCount = Object.values(state.slots).filter((s) => s.pinned).length;

    if (pinnedCount > targetCount) {
      throw new Error(
        `Cannot reduce slot count to ${targetCount}: ${pinnedCount} worktrees are pinned. Unpin worktrees first or choose a higher count.`,
      );
    }

    // Sort non-pinned slots for eviction:
    //   Primary: LRU (oldest last_used_at first)
    //   Tie-break: vacant slots before occupied ones
    // The tie-break ensures that after `wt init` (where all slots share the same
    // timestamp), vacant slots are always evicted before the active slot (BUG-026).
    const evictionCandidates = Object.entries(state.slots)
      .filter(([, slot]) => !slot.pinned)
      .sort(([, a], [, b]) => {
        const timeDiff = new Date(a.last_used_at).getTime() - new Date(b.last_used_at).getTime();
        if (timeDiff !== 0) return timeDiff;
        // Equal timestamps: prefer evicting vacant over occupied
        const aVacant = a.branch === null ? 0 : 1;
        const bVacant = b.branch === null ? 0 : 1;
        return aVacant - bVacant;
      });

    const toEvict = evictionCandidates.slice(0, excessCount);

    for (const [slotName, slot] of toEvict) {
      const slotPath = join(containerDir, slotName);

      if (slot.branch !== null) {
        // Save stash if dirty, then clean so worktree remove succeeds
        const stashed = await saveStash(
          wtDir,
          repoDir,
          slot.branch,
          slotPath,
          config.shared,
        );
        if (stashed) {
          await hardReset(slotPath);
          await cleanUntracked(slotPath);
        }
      }

      await worktreeRemove(repoDir, slotPath);
      delete state.slots[slotName];
    }

    await writeState(wtDir, state);
  }

  return state;
}
