import path from "path";
import { findContainer } from "../core/container.js";
import { readState, writeState } from "../core/state.js";
import { readConfig } from "../core/config.js";
import { reconcile } from "../core/reconcile.js";
import * as git from "../core/git.js";
import {
  findSlotForBranch,
  selectSlotForCheckout,
  isVacant,
  markSlotUsed,
  markSlotVacant,
  adjustSlotCount,
} from "../core/slots.js";
import { saveStash, restoreStash, touchStash, archiveScan } from "../core/stash.js";
import { generateTemplates } from "../core/templates.js";
import { establishSymlinks } from "../core/symlinks.js";
import { writeNavFile } from "../core/nav.js";

export interface CheckoutOptions {
  branch: string;
  noRestore?: boolean;  // --no-restore flag
  cwd?: string;         // override cwd for testing
}

/**
 * Execute the full checkout flow.
 * Returns the path to the target worktree (for nav file).
 */
export async function runCheckout(options: CheckoutOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();

  // 1. FIND CONTAINER
  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }

  // 2. READ STATE + CONFIG
  let state = await readState(paths.wtDir);
  const config = await readConfig(paths.wtDir);

  // 3. RECONCILE
  state = await reconcile(paths.wtDir, paths.container, state);

  // 3b. ADJUST SLOT COUNT if config changed
  if (Object.keys(state.slots).length !== config.slot_count) {
    state = await adjustSlotCount(paths.repoDir, paths.container, paths.wtDir, state, config);
  }

  // 4. FETCH (errors pass through verbatim)
  try {
    await git.fetch(paths.repoDir);
  } catch {
    // Fetch errors are not fatal — continue with local state
  }

  // 5. ARCHIVE SCAN
  try {
    const { archived } = await archiveScan(
      paths.wtDir,
      paths.repoDir,
      config.archive_after_days
    );
    if (archived.length > 0) {
      process.stderr.write(
        `Archived ${archived.length} stash(es): ${archived.join(", ")}\n`
      );
    }
  } catch {
    // Archive scan errors are not fatal — continue checkout
  }

  // 6. BRANCH ALREADY IN A SLOT?
  const existingSlot = findSlotForBranch(state, options.branch);
  if (existingSlot) {
    // Just navigate to it
    await touchStash(paths.wtDir, options.branch);
    markSlotUsed(state, existingSlot, options.branch);
    // Update branch_history
    state.branch_history = state.branch_history.filter(
      (e) => e.branch !== options.branch
    );
    state.branch_history.unshift({
      branch: options.branch,
      last_checkout_at: new Date().toISOString(),
    });
    await writeState(paths.wtDir, state);
    const targetDir = path.join(paths.container, existingSlot);
    await writeNavFile(targetDir);
    return targetDir;
  }

  // 7. SELECT A SLOT
  const targetSlot = selectSlotForCheckout(state);
  const worktreeDir = path.join(paths.container, targetSlot);

  // 8. EVICT (if slot is not vacant)
  if (!isVacant(state.slots[targetSlot])) {
    const evictedBranch = state.slots[targetSlot].branch!;

    // Save stash if dirty.
    // Note: git stash create does NOT clean the working tree — it only records
    // the dirty state as a commit object. We must reset + clean manually so that
    // the subsequent branch checkout does not fail with "local changes would be
    // overwritten".
    const stashed = await saveStash(paths.wtDir, paths.repoDir, evictedBranch, worktreeDir);
    if (stashed) {
      await git.hardReset(worktreeDir);
      await git.cleanUntracked(worktreeDir);
    }

    // Detach HEAD
    await git.checkoutDetach(worktreeDir);
    markSlotVacant(state, targetSlot);
  }

  // 9. CHECKOUT BRANCH
  let checkoutError: unknown = null;
  try {
    await git.checkout(worktreeDir, options.branch);
  } catch (err) {
    checkoutError = err;
  }

  if (checkoutError !== null) {
    // Branch doesn't exist locally — try creating from origin/<branch>
    const remoteExists = await git.remoteBranchExists(
      paths.repoDir,
      options.branch
    );
    if (remoteExists) {
      await git.checkoutTrack(worktreeDir, options.branch);
    } else {
      // No remote branch — let git error pass through
      throw checkoutError;
    }
  }

  // 10. RESTORE STASH
  if (!options.noRestore) {
    await restoreStash(paths.wtDir, paths.repoDir, options.branch, worktreeDir);
    // Warnings already printed by restoreStash on conflict
  }

  // 11. REGENERATE TEMPLATES
  await generateTemplates(
    paths.wtDir,
    worktreeDir,
    targetSlot,
    options.branch,
    config.templates
  );

  // 12. ESTABLISH SYMLINKS
  await establishSymlinks(
    paths.wtDir,
    worktreeDir,
    config.shared.directories,
    options.branch
  );

  // 13. UPDATE STATE
  markSlotUsed(state, targetSlot, options.branch);
  state.branch_history = state.branch_history.filter(
    (e) => e.branch !== options.branch
  );
  state.branch_history.unshift({
    branch: options.branch,
    last_checkout_at: new Date().toISOString(),
  });
  await writeState(paths.wtDir, state);

  // 14. POST-CHECKOUT HOOK
  // Hook execution happens in the shell function, not here.
  // The binary just writes the nav file; the shell handles the hook.

  // 15. NAVIGATE
  await writeNavFile(worktreeDir);
  return worktreeDir;
}
