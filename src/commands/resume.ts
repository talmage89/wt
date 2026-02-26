import path from "path";
import { findContainer, currentSlotName } from "../core/container.js";
import { readState } from "../core/state.js";
import { reconcile } from "../core/reconcile.js";
import { writeNavFile } from "../core/nav.js";

/**
 * `wt -` / `wt resume`: navigate to the most recently used worktree slot.
 *
 * Finds the slot with the highest last_used_at timestamp that has a non-null
 * branch, writes the nav file, and lets the shell function handle the cd.
 *
 * No-op if already in the MRU slot. Error if all slots are vacant.
 */
export async function runResume(options?: { cwd?: string }): Promise<void> {
  const cwd = options?.cwd ?? process.cwd();

  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }

  let state = await readState(paths.wtDir);
  state = await reconcile(paths.wtDir, paths.container, state);

  // Find the slot with the most recent last_used_at that has a branch assigned
  let mruSlot: string | null = null;
  let mruTime = new Date(0);

  for (const [name, slot] of Object.entries(state.slots)) {
    if (slot.branch === null) continue; // skip vacant slots
    const t = new Date(slot.last_used_at);
    if (t > mruTime) {
      mruTime = t;
      mruSlot = name;
    }
  }

  if (!mruSlot) {
    throw new Error("No worktree slots are currently in use.");
  }

  const targetDir = path.join(paths.container, mruSlot);

  // No-op if we're already in the MRU slot
  const currentSlot = currentSlotName(cwd, paths);
  if (currentSlot === mruSlot) {
    const branch = state.slots[mruSlot].branch!;
    process.stderr.write(
      `wt: Already in the most recently used worktree (${branch} in ${mruSlot})\n`
    );
    return;
  }

  await writeNavFile(targetDir);

  const branch = state.slots[mruSlot].branch!;
  process.stderr.write(`wt: Resuming ${branch} in ${mruSlot}\n`);
  if (process.env["WT_SHELL_INTEGRATION"]) {
    process.stderr.write(`wt: Navigating to ${targetDir}\n`);
  }
}
