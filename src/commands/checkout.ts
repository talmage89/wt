import path from "path";
import { findContainer, validateContainer } from "../core/container.js";
import { readState, writeState } from "../core/state.js";
import { readConfig } from "../core/config.js";
import { reconcile } from "../core/reconcile.js";
import { acquireLock } from "../core/lock.js";
import * as git from "../core/git.js";
import {
  findSlotForBranch,
  selectSlotForCheckout,
  isVacant,
  markSlotUsed,
  markSlotVacant,
  adjustSlotCount,
} from "../core/slots.js";
import { saveStash, restoreStash, touchStash, archiveScan, getStash } from "../core/stash.js";
import { generateTemplates } from "../core/templates.js";
import { establishSymlinks, removeSymlinks } from "../core/symlinks.js";
import { writeNavFile } from "../core/nav.js";

/**
 * Format an ISO date string as a human-readable relative time.
 * Examples: "just now", "3 minutes ago", "2 hours ago", "5 days ago"
 */
function relativeTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export interface CheckoutOptions {
  branch: string;
  noRestore?: boolean;   // --no-restore flag
  create?: boolean;      // -b flag: create a new branch
  startPoint?: string;   // start point for branch creation (default: origin/<default-branch>)
  cwd?: string;          // override cwd for testing
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
  await validateContainer(paths);

  const release = await acquireLock(paths.wtDir);
  try {
  // 2. READ STATE + CONFIG
  let state = await readState(paths.wtDir);
  const config = await readConfig(paths.wtDir);

  // 3. RECONCILE
  state = await reconcile(paths.wtDir, paths.container, state);

  // 3b. ADJUST SLOT COUNT if config changed
  if (Object.keys(state.slots).length !== config.slot_count) {
    state = await adjustSlotCount(paths.repoDir, paths.container, paths.wtDir, state, config);
  }

  // 4. FETCH WITH COOLDOWN — skip if last fetch was within the configured window
  {
    const cooldownMs = (config.fetch_cooldown_minutes) * 60_000;
    const lastFetchAt = state.last_fetch_at;
    const elapsed = lastFetchAt
      ? Date.now() - new Date(lastFetchAt).getTime()
      : Infinity;
    if (elapsed >= cooldownMs) {
      try {
        await git.fetch(paths.repoDir);
        state.last_fetch_at = new Date().toISOString();
      } catch {
        // Fetch errors are not fatal — continue with local state
      }
    }
    // else: silently skip (within cooldown window)
  }

  // 5. ARCHIVE SCAN — exclude the target branch so its stash is not archived
  // before the restore step below (BUG-021).
  try {
    const { archived } = await archiveScan(
      paths.wtDir,
      paths.repoDir,
      config.archive_after_days,
      options.branch
    );
    if (archived.length > 0) {
      process.stderr.write(
        `Archived ${archived.length} stash(es): ${archived.join(", ")}\n`
      );
    }
  } catch {
    // Archive scan errors are not fatal — continue checkout
  }

  // 6. BRANCH ALREADY IN A SLOT? (skipped when creating a new branch)
  const existingSlot = !options.create ? findSlotForBranch(state, options.branch) : null;
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
    // Feedback
    process.stderr.write(`wt: Checked out ${options.branch} in ${existingSlot}\n`);
    if (process.env["WT_SHELL_INTEGRATION"]) {
      process.stderr.write(`wt: Navigating to ${targetDir}\n`);
    }
    return targetDir;
  }

  // 7. SELECT A SLOT
  const targetSlot = selectSlotForCheckout(state);
  const worktreeDir = path.join(paths.container, targetSlot);

  // Tracks whether the branch existed locally before checkout (used to detect
  // when git's DWIM creates a local tracking branch — BUG-029).
  let localBranchExistedBefore = true;

  // 7.5. PRE-CHECK: Verify the branch exists before evicting any slot (BUG-028).
  // Eviction is irreversible — if the subsequent checkout fails, the evicted
  // slot is left vacant with its original branch assignment lost. Fail early
  // with a clear error if the branch doesn't exist locally or on the remote.
  // Only applies to the non-create path; -b creates a new branch at startPoint.
  if (!options.create) {
    const localExists = await git.refExists(
      paths.repoDir,
      `refs/heads/${options.branch}`
    );
    // BUG-029: bare clone creates refs/heads/* for all remote branches, so
    // refExists is always true for known branches. Use branch_history to
    // detect first-time checkout (i.e., "created from remote").
    localBranchExistedBefore = state.branch_history.some(
      (e) => e.branch === options.branch
    );
    if (!localExists) {
      const remoteExists = await git.remoteBranchExists(
        paths.repoDir,
        options.branch
      );
      if (!remoteExists) {
        throw new Error(
          `Branch '${options.branch}' not found locally or on remote.`
        );
      }
    }
  }

  // 7.6. PRE-CHECK for -b: Validate before evicting (item 1.5).
  // If the branch already exists locally or the start point is invalid, a slot
  // would be evicted and left vacant when the subsequent checkout fails.
  // Fail early to prevent that.
  if (options.create) {
    const localExists = await git.refExists(
      paths.repoDir,
      `refs/heads/${options.branch}`
    );
    if (localExists) {
      throw new Error(`Branch '${options.branch}' already exists.`);
    }
    if (options.startPoint) {
      await git.verifyRevision(paths.repoDir, options.startPoint);
    }
  }

  // Feedback tracking
  let evictedBranch: string | null = null;
  let wasStashed = false;
  let branchCreatedFromRemote = false;
  let branchCreatedExplicitly = false;
  let explicitStartPoint: string | null = null;
  let stashRestoredAt: string | null = null;

  // 8. EVICT (if slot is not vacant)
  if (!isVacant(state.slots[targetSlot])) {
    evictedBranch = state.slots[targetSlot].branch!;

    // Save stash if dirty.
    // Note: git stash create does NOT clean the working tree — it only records
    // the dirty state as a commit object. We must reset + clean manually so that
    // the subsequent branch checkout does not fail with "local changes would be
    // overwritten".
    wasStashed = await saveStash(paths.wtDir, paths.repoDir, evictedBranch, worktreeDir, config.shared.directories);
    if (wasStashed) {
      await git.hardReset(worktreeDir);
      await git.cleanUntracked(worktreeDir);
    }

    // Detach HEAD
    await git.checkoutDetach(worktreeDir);
    markSlotVacant(state, targetSlot);
  }

  // 9. CHECKOUT BRANCH
  // Remove managed symlinks from target slot before git checkout.
  // git refuses to checkout if a symlink exists for a file the target branch tracks.
  await removeSymlinks(paths.wtDir, worktreeDir, config.shared.directories);

  if (options.create) {
    // -b flag: create a new local branch at the given start point
    let resolvedStartPoint = options.startPoint;
    if (!resolvedStartPoint) {
      const defBranch = await git.defaultBranch(paths.repoDir);
      resolvedStartPoint = `origin/${defBranch}`;
    }
    await git.checkoutCreate(worktreeDir, options.branch, resolvedStartPoint);
    branchCreatedExplicitly = true;
    explicitStartPoint = resolvedStartPoint;
  } else {
    let checkoutError: unknown = null;
    try {
      await git.checkout(worktreeDir, options.branch);
      // git's DWIM behavior creates a local tracking branch when a remote-only
      // branch is checked out. Detect this case using the pre-check result.
      // BUG-030: also verify a remote tracking ref exists — without this check,
      // locally-created branches and no-remote repos trigger a false positive.
      if (!localBranchExistedBefore) {
        const remoteExists = await git.remoteBranchExists(paths.repoDir, options.branch);
        if (remoteExists) {
          branchCreatedFromRemote = true;
        }
      }
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
        branchCreatedFromRemote = true;
      } else {
        // No remote branch — let git error pass through
        throw checkoutError;
      }
    }
  }

  // 10. RESTORE STASH
  if (!options.noRestore) {
    // Read stash metadata before restoring (metadata is deleted on success)
    const stashMeta = await getStash(paths.wtDir, options.branch);
    if (stashMeta?.status === "archived") {
      // Archived stash exists but cannot be auto-restored — notify the user
      process.stderr.write(
        `wt: Archived stash for ${options.branch} was not auto-restored. View with 'wt stash show ${options.branch}'.\n`
      );
    } else {
      const stashCreatedAt = stashMeta?.created_at ?? null;
      const stashResult = await restoreStash(paths.wtDir, paths.repoDir, options.branch, worktreeDir);
      if (stashResult === "restored" && stashCreatedAt) {
        stashRestoredAt = stashCreatedAt;
      }
    }
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

  // 16. PRINT FEEDBACK
  process.stderr.write(`wt: Checked out ${options.branch} in ${targetSlot}\n`);
  if (evictedBranch !== null) {
    const dirtyNote = wasStashed ? " (dirty state stashed)" : "";
    process.stderr.write(`wt: Evicted ${evictedBranch} from ${targetSlot}${dirtyNote}\n`);
  }
  if (branchCreatedExplicitly) {
    process.stderr.write(`wt: Created branch ${options.branch} from ${explicitStartPoint}\n`);
  }
  if (branchCreatedFromRemote) {
    process.stderr.write(`wt: Created local branch ${options.branch} from origin/${options.branch}\n`);
  }
  if (stashRestoredAt !== null) {
    process.stderr.write(`wt: Restored stash from ${relativeTime(stashRestoredAt)}\n`);
  }
  if (process.env["WT_SHELL_INTEGRATION"]) {
    process.stderr.write(`wt: Navigating to ${worktreeDir}\n`);
  }

  return worktreeDir;
  } finally {
    await release();
  }
}
