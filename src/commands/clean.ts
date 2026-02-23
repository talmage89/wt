import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { findContainer, validateContainer } from "../core/container.js";
import { readState, writeState } from "../core/state.js";
import { readConfig } from "../core/config.js";
import { reconcile } from "../core/reconcile.js";
import { acquireLock } from "../core/lock.js";
import { listStashes, dropStash, archiveScan, StashMetadata } from "../core/stash.js";

export interface CleanOptions {
  cwd?: string;
  /** Skip interactive prompts (for testing). If set, selects all archived stashes. */
  autoConfirm?: boolean;
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
 * Get approximate size of an archive file in human-readable format.
 */
async function archiveSize(archivePath: string): Promise<string> {
  try {
    const st = await fs.stat(archivePath);
    const bytes = st.size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return "?";
  }
}

/**
 * Prompt for input via readline.
 */
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * `wt clean` — interactive review and deletion of archived stashes.
 * Also triggers an archive scan (stub in Phase 5; full implementation in Phase 6).
 */
export async function runClean(options: CleanOptions = {}): Promise<void> {
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

    const config = await readConfig(paths.wtDir);
    await archiveScan(paths.wtDir, paths.repoDir, config.archive_after_days);

    const allStashes = await listStashes(paths.wtDir);
    const archived = allStashes.filter((s) => s.status === "archived");

    if (archived.length === 0) {
      process.stdout.write("No archived stashes to clean.\n");
      return;
    }

    // Display archived stashes with index
    process.stdout.write("Archived stashes:\n\n");
    for (let i = 0; i < archived.length; i++) {
      const s = archived[i];
      const age = relativeTime(s.created_at);
      const size = s.archive_path ? await archiveSize(s.archive_path) : "?";
      process.stdout.write(`  [${i + 1}] ${s.branch}  (${age}, ${size})\n`);
    }
    process.stdout.write("\n");

    let selected: StashMetadata[];

    if (options.autoConfirm) {
      selected = archived;
    } else {
      const answer = await prompt(
        "Select stashes to delete (comma-separated numbers, 'all', or 'none'): "
      );

      if (answer === "none" || answer === "") {
        process.stdout.write("Aborted.\n");
        return;
      }

      if (answer === "all") {
        selected = archived;
      } else {
        const indices = answer
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n) && n >= 1 && n <= archived.length)
          .map((n) => n - 1);

        if (indices.length === 0) {
          process.stdout.write("No valid selection. Aborted.\n");
          return;
        }

        selected = indices.map((i) => archived[i]);
      }

      const confirmAnswer = await prompt(
        `Delete ${selected.length} stash${selected.length === 1 ? "" : "es"}? [y/N] `
      );

      if (confirmAnswer.toLowerCase() !== "y" && confirmAnswer.toLowerCase() !== "yes") {
        process.stdout.write("Aborted.\n");
        return;
      }
    }

    for (const s of selected) {
      await dropStash(paths.wtDir, paths.repoDir, s.branch);
    }

    process.stdout.write(
      `Deleted ${selected.length} archived stash${selected.length === 1 ? "" : "es"}.\n`
    );
  } finally {
    await release();
  }
}
