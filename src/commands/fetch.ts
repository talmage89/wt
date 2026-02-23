import { findContainer } from "../core/container.js";
import { readState, writeState } from "../core/state.js";
import { readConfig } from "../core/config.js";
import { reconcile } from "../core/reconcile.js";
import * as git from "../core/git.js";
import { archiveScan } from "../core/stash.js";

export interface FetchOptions {
  cwd?: string;
}

/**
 * Run a centralized git fetch and trigger archive scan.
 * Flow:
 * 1. Find container
 * 2. Reconcile state
 * 3. Fetch from remote
 * 4. Archive scan (stub — full implementation in Phase 6)
 */
export async function runFetch(options: FetchOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  const paths = await findContainer(cwd);
  if (!paths) {
    throw new Error("Not inside a wt-managed container.");
  }

  let state = await readState(paths.wtDir);
  state = await reconcile(paths.wtDir, paths.container, state);
  await writeState(paths.wtDir, state);

  await git.fetch(paths.repoDir);
  process.stdout.write("Fetched latest from remote.\n");

  const config = await readConfig(paths.wtDir);
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
}
