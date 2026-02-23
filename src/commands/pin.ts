import { findContainer, validateContainer, currentSlotName } from "../core/container.js";
import { readState, writeState } from "../core/state.js";
import { reconcile } from "../core/reconcile.js";
import { acquireLock } from "../core/lock.js";

export interface PinOptions {
  cwd?: string;
}

/**
 * `wt pin [slot]` — pin a worktree slot to prevent LRU eviction.
 */
export async function runPin(
  slotName?: string,
  options: PinOptions = {}
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

    // Resolve slot
    const resolvedSlot = slotName ?? currentSlotName(cwd, paths);
    if (!resolvedSlot) {
      throw new Error("Not inside a worktree slot. Specify a slot name.");
    }

    if (!(resolvedSlot in state.slots)) {
      throw new Error(`Slot '${resolvedSlot}' not found.`);
    }

    if (state.slots[resolvedSlot].pinned) {
      process.stdout.write(`Slot '${resolvedSlot}' is already pinned.\n`);
      return;
    }

    state.slots[resolvedSlot].pinned = true;
    await writeState(paths.wtDir, state);

    const branch = state.slots[resolvedSlot].branch ?? "(vacant)";
    process.stdout.write(
      `Pinned '${resolvedSlot}' (branch: ${branch}). It will not be evicted.\n`
    );
  } finally {
    await release();
  }
}

/**
 * `wt unpin [slot]` — unpin a worktree slot.
 */
export async function runUnpin(
  slotName?: string,
  options: PinOptions = {}
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

    // Resolve slot
    const resolvedSlot = slotName ?? currentSlotName(cwd, paths);
    if (!resolvedSlot) {
      throw new Error("Not inside a worktree slot. Specify a slot name.");
    }

    if (!(resolvedSlot in state.slots)) {
      throw new Error(`Slot '${resolvedSlot}' not found.`);
    }

    if (!state.slots[resolvedSlot].pinned) {
      process.stdout.write(`Slot '${resolvedSlot}' is not pinned.\n`);
      return;
    }

    state.slots[resolvedSlot].pinned = false;
    await writeState(paths.wtDir, state);

    const branch = state.slots[resolvedSlot].branch ?? "(vacant)";
    process.stdout.write(
      `Unpinned '${resolvedSlot}' (branch: ${branch}). It can now be evicted via LRU.\n`
    );
  } finally {
    await release();
  }
}
