import { join } from "path";
import { generateSlotName } from "./words.js";
import { worktreeAdd } from "./git.js";
import type { State, SlotState } from "./state.js";

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
  existingSlotNames: Set<string>
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
      "All worktree slots are pinned. Unpin a worktree or increase the slot count to continue."
    );
  }

  // Sort by last_used_at ascending (oldest first)
  unpinned.sort(
    ([, a], [, b]) =>
      new Date(a.last_used_at).getTime() - new Date(b.last_used_at).getTime()
  );

  return unpinned[0][0];
}

/**
 * Mark a slot as used with a branch. Updates LRU timestamp.
 */
export function markSlotUsed(
  state: State,
  slotName: string,
  branch: string
): void {
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
