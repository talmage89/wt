import path from "node:path";
import { readConfig } from "../core/config.js";
import { findContainer, validateContainer } from "../core/container.js";
import * as git from "../core/git.js";
import { acquireLock } from "../core/lock.js";
import { reconcile } from "../core/reconcile.js";
import { adjustSlotCount } from "../core/slots.js";
import { readState, writeState } from "../core/state.js";

export interface ListOptions {
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
 * `wt list` — display all worktree slots with branch, status, pin, and last-used.
 */
export async function runList(options: ListOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }
  await validateContainer(paths);

  const release = await acquireLock(paths.wtDir);
  try {
    let state = await readState(paths.wtDir);
    const config = await readConfig(paths.wtDir);
    state = await reconcile(paths.wtDir, paths.container, state);

    // Adjust slot count if config changed
    if (Object.keys(state.slots).length !== config.slot_count) {
      state = await adjustSlotCount(paths.repoDir, paths.container, paths.wtDir, state, config);
    }

    await writeState(paths.wtDir, state);

    // Collect info for each slot
    const slotW = 10;
    const branchW = 22;
    const statusW = 8;
    const pinnedW = 8;

    const header =
      "Slot".padEnd(slotW) +
      "Branch".padEnd(branchW) +
      "Status".padEnd(statusW) +
      "Pinned".padEnd(pinnedW) +
      "Last Used";
    const divider =
      "─".repeat(slotW - 2) +
      "  " +
      "─".repeat(branchW - 2) +
      "  " +
      "─".repeat(statusW - 2) +
      "  " +
      "─".repeat(pinnedW - 2) +
      "  " +
      "─".repeat(10);

    process.stdout.write(`${header}\n`);
    process.stdout.write(`${divider}\n`);

    for (const [slotName, slot] of Object.entries(state.slots)) {
      const worktreeDir = path.join(paths.container, slotName);
      const branchDisplay = slot.branch ?? "(vacant)";

      // Check git status for dirty/clean
      let statusDisplay = "";
      if (slot.branch) {
        try {
          const porcelain = await git.status(worktreeDir);
          statusDisplay = porcelain.trim().length > 0 ? "dirty" : "clean";
        } catch {
          statusDisplay = "?";
        }
      }

      const pinnedDisplay = slot.pinned ? "pinned" : "";
      const lastUsed = relativeTime(slot.last_used_at);

      const slotDisplay =
        slotName.length > slotW - 2 ? `${slotName.slice(0, slotW - 5)}...` : slotName;
      const branchTrunc =
        branchDisplay.length > branchW - 2
          ? `${branchDisplay.slice(0, branchW - 5)}...`
          : branchDisplay;

      const line =
        slotDisplay.padEnd(slotW) +
        branchTrunc.padEnd(branchW) +
        statusDisplay.padEnd(statusW) +
        pinnedDisplay.padEnd(pinnedW) +
        lastUsed;

      process.stdout.write(`${line}\n`);
    }
  } finally {
    await release();
  }
}
