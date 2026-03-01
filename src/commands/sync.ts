import { readConfig } from "../core/config.js";
import { findContainer, validateContainer } from "../core/container.js";
import { acquireLock } from "../core/lock.js";
import { reconcile } from "../core/reconcile.js";
import { readState, writeState } from "../core/state.js";
import { syncAllSymlinks } from "../core/symlinks.js";
import { generateAllTemplates } from "../core/templates.js";

export interface SyncOptions {
  cwd?: string; // override cwd for testing
}

/**
 * Run the full sync flow:
 * 1. Find container
 * 2. Read state + config
 * 3. Reconcile
 * 4. Sync all symlinks
 * 5. Regenerate all templates
 */
export async function runSync(options: SyncOptions = {}): Promise<void> {
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
    await writeState(paths.wtDir, state);

    // 4. SYNC ALL SYMLINKS
    await syncAllSymlinks(paths.wtDir, paths.container, state.slots, config.shared);

    // 5. REGENERATE ALL TEMPLATES
    await generateAllTemplates(paths.wtDir, paths.container, state.slots, config.templates);
  } finally {
    await release();
  }
}
