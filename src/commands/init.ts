import { access, readdir, rename, rm, stat } from "fs/promises";
import { join } from "path";
import { execa } from "execa";
import { createContainerStructure } from "../core/container.js";
import { createSlots } from "../core/slots.js";
import { writeState, defaultState } from "../core/state.js";
import { writeConfig, defaultConfig } from "../core/config.js";
import { writeNavFile } from "../core/nav.js";
import { generateAllTemplates } from "../core/templates.js";
import * as git from "../core/git.js";

export interface InitOptions {
  /** If provided, bare-clone from this URL. Otherwise, restructure the cwd repo. */
  url?: string;
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Initialize a wt-managed container.
 * Returns the path to the active worktree slot (for shell navigation).
 */
export async function runInit(options: InitOptions): Promise<string> {
  const containerDir = options.cwd ?? process.cwd();

  if (options.url) {
    return await initFromUrl(containerDir, options.url);
  } else {
    return await initFromExistingRepo(containerDir);
  }
}

// ---------------------------------------------------------------------------
// Init from existing git repository
// ---------------------------------------------------------------------------

async function initFromExistingRepo(containerDir: string): Promise<string> {
  // Validate: not already initialized (check this FIRST — after init, .git is gone)
  const wtDirCheck = join(containerDir, ".wt");
  if (await exists(wtDirCheck)) {
    throw new Error("This directory is already a wt-managed container.");
  }

  // Validate: must be a git repository (.git/ must be a directory, not a file)
  // A worktree slot has a .git FILE (worktree link) rather than a .git/ directory.
  // We must check for a directory specifically to avoid corrupting a slot.
  const gitDir = join(containerDir, ".git");
  let gitStat: import("fs").Stats | null = null;
  try {
    gitStat = await stat(gitDir);
  } catch {
    // .git doesn't exist at all
  }
  if (!gitStat) {
    throw new Error(
      "Not at the root of a git repository. Run 'wt init' from the repository root (where .git/ lives), or use 'wt init <url>' to clone a new one."
    );
  }
  if (!gitStat.isDirectory()) {
    throw new Error(
      "Not a git repository root. Run 'wt init' from a regular git repository, not inside a worktree slot."
    );
  }

  // Get current branch (may be null if detached HEAD)
  const startingBranch = await git.currentBranch(containerDir);

  // Stash dirty state before restructuring
  const stashHash = await git.stashCreate(containerDir);

  // Create .wt/ directory structure
  const wtDir = await createContainerStructure(containerDir);
  const repoDir = join(wtDir, "repo");

  // Remove the pre-created empty .wt/repo/ so we can rename .git into that spot
  await rm(repoDir, { recursive: true, force: true });

  // Move .git → .wt/repo/
  await rename(gitDir, repoDir);

  // Convert to a bare-style repo (no working tree)
  await git.setConfig(repoDir, "core.bare", "true");

  // Fetch remote (best-effort — repo might have no remote or be offline)
  try {
    await git.fetch(repoDir);
  } catch {
    // No remote or network failure — continue with local state
  }

  // Check if any remote tracking refs actually exist after fetch.
  // git fetch succeeds silently for repos with no remotes, so we must
  // verify refs exist before using origin/<branch> as a commit reference.
  const hasRemote = await hasRemoteRefs(repoDir);

  // Detect default branch
  let defaultBranchName: string;
  try {
    defaultBranchName = await git.defaultBranch(repoDir);
  } catch {
    defaultBranchName = startingBranch ?? "main";
  }
  // If no remote, defaultBranch() may have returned "master" as fallback;
  // prefer the actual starting branch name when there's no remote.
  const effectiveDefault = hasRemote ? defaultBranchName : (startingBranch ?? defaultBranchName);

  // Create worktree slots
  const config = defaultConfig();
  const slotCommit = hasRemote ? `origin/${effectiveDefault}` : "HEAD";
  const slotNames = await createSlots(
    repoDir,
    containerDir,
    config.slot_count,
    slotCommit,
    new Set()
  );

  // Checkout the starting branch in slot 0
  const slot0Dir = join(containerDir, slotNames[0]);
  if (startingBranch) {
    // The starting branch exists locally in .wt/repo — direct checkout works
    await git.checkout(slot0Dir, startingBranch);
  }

  // Restore stash if dirty state was saved
  if (stashHash) {
    const result = await git.stashApply(slot0Dir, stashHash);
    if (result.conflicted) {
      process.stderr.write(
        `wt: stash for '${startingBranch ?? "HEAD"}' produced conflicts. Resolve manually.\n`
      );
    }
  }

  // Remove the original working tree files from the container root.
  // These are now in git history; the slots hold the working copies.
  const itemsToKeep = new Set([".wt", ...slotNames]);
  await removeWorkingTreeFiles(containerDir, itemsToKeep);

  // Build initial state
  const now = new Date().toISOString();
  const state = defaultState();
  for (const name of slotNames) {
    state.slots[name] = {
      branch: name === slotNames[0] ? (startingBranch ?? null) : null,
      last_used_at: now,
      pinned: false,
    };
  }
  if (startingBranch) {
    state.branch_history.push({
      branch: startingBranch,
      last_checkout_at: now,
    });
  }

  await writeState(wtDir, state);
  await writeConfig(wtDir, config);
  await generateAllTemplates(wtDir, containerDir, state.slots, config.templates);

  // Print post-init summary
  printInitSummary(slotNames, slotNames[0], startingBranch);

  // Write nav file so the shell function can cd into the active slot
  await writeNavFile(slot0Dir);

  return slot0Dir;
}

// ---------------------------------------------------------------------------
// Init from URL (bare clone)
// ---------------------------------------------------------------------------

async function initFromUrl(containerDir: string, url: string): Promise<string> {
  // Validate: directory must be empty
  const items = await readdir(containerDir);
  if (items.length > 0) {
    throw new Error(
      "Directory is not empty. Use 'wt init' from inside an existing repository, or run from an empty directory."
    );
  }

  // Create .wt/ structure
  const wtDir = await createContainerStructure(containerDir);
  const repoDir = join(wtDir, "repo");

  // Bare-clone into .wt/repo/.
  // Note: createContainerStructure creates .wt/repo/ as an empty dir;
  // git clone --bare into an existing empty directory works fine.
  await git.cloneBare(url, repoDir);

  // git clone --bare uses a non-standard fetch refspec (+refs/heads/*:refs/heads/*)
  // that does NOT create refs/remotes/origin/* tracking refs. Switch to the
  // standard tracking refspec so subsequent fetches populate refs/remotes/origin/*.
  await git.setConfig(
    repoDir,
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*"
  );

  // Fetch to populate refs/remotes/origin/* with the corrected refspec.
  // This enables defaultBranch() to work and origin/<branch> refs for slot creation.
  await git.fetch(repoDir);

  // Set refs/remotes/origin/HEAD to the remote's actual default branch.
  // Bare clone + fetch does not create this ref automatically, but
  // defaultBranch() relies on it as the primary detection method.
  try {
    await execa("git", ["remote", "set-head", "origin", "--auto"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Non-fatal: defaultBranch() has fallbacks for this case
  }

  // Detect default branch from remote tracking refs (now populated).
  const defaultBranchName = await git.defaultBranch(repoDir);

  // Create worktree slots, all detached at the default branch tip
  const config = defaultConfig();
  const slotNames = await createSlots(
    repoDir,
    containerDir,
    config.slot_count,
    `origin/${defaultBranchName}`,
    new Set()
  );

  // Checkout the default branch in slot 0
  const slot0Dir = join(containerDir, slotNames[0]);
  await checkoutOrTrack(slot0Dir, defaultBranchName);

  // Build initial state
  const now = new Date().toISOString();
  const state = defaultState();
  for (const name of slotNames) {
    state.slots[name] = {
      branch: name === slotNames[0] ? defaultBranchName : null,
      last_used_at: now,
      pinned: false,
    };
  }
  state.branch_history.push({
    branch: defaultBranchName,
    last_checkout_at: now,
  });

  await writeState(wtDir, state);
  await writeConfig(wtDir, config);
  await generateAllTemplates(wtDir, containerDir, state.slots, config.templates);

  // Print post-init summary
  printInitSummary(slotNames, slotNames[0], defaultBranchName);

  // Write nav file
  await writeNavFile(slot0Dir);

  return slot0Dir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Print the post-init summary to stderr.
 * Shows all slot names, marks the active one, and emits a shell integration
 * hint unless WT_SHELL_INTEGRATION is already set (wrapper already sourced).
 */
function printInitSummary(
  slotNames: string[],
  activeSlotName: string | null,
  activeBranch: string | null
): void {
  const count = slotNames.length;
  process.stderr.write(
    `wt: Initialized with ${count} worktree slot${count === 1 ? "" : "s"}.\n`
  );
  for (const name of slotNames) {
    if (name === activeSlotName && activeBranch) {
      process.stderr.write(`wt:   ${name}  (active, branch: ${activeBranch})\n`);
    } else {
      process.stderr.write(`wt:   ${name}  (vacant)\n`);
    }
  }
  if (!process.env.WT_SHELL_INTEGRATION) {
    process.stderr.write(`wt:\n`);
    process.stderr.write(
      `wt: To enable shell navigation (cd on checkout), add to your shell config:\n`
    );
    process.stderr.write(`wt:   eval "$(wt shell-init bash)"    # bash\n`);
    process.stderr.write(`wt:   eval "$(wt shell-init zsh)"     # zsh\n`);
    process.stderr.write(`wt:   wt shell-init fish | source     # fish\n`);
    process.stderr.write(`wt:\n`);
    process.stderr.write(`wt: Then restart your shell or run the eval command now.\n`);
  }
}

/**
 * Check if a path exists.
 */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove all items in containerDir except those in `keepItems`.
 */
async function removeWorkingTreeFiles(
  containerDir: string,
  keepItems: Set<string>
): Promise<void> {
  const items = await readdir(containerDir);
  for (const item of items) {
    if (!keepItems.has(item)) {
      await rm(join(containerDir, item), { recursive: true, force: true });
    }
  }
}

/**
 * Checkout a branch in a worktree. If the branch doesn't exist locally
 * but origin/<branch> does, create a local tracking branch.
 */
async function checkoutOrTrack(
  worktreeDir: string,
  branch: string
): Promise<void> {
  try {
    await git.checkout(worktreeDir, branch);
  } catch {
    // Branch not available locally — create tracking branch from origin
    await execa(
      "git",
      ["checkout", "-b", branch, "--track", `origin/${branch}`],
      {
        cwd: worktreeDir,
        stdio: ["ignore", "pipe", "inherit"],
      }
    );
  }
}

/**
 * Check if any remote tracking refs (refs/remotes/*) exist in the repo.
 * Used to distinguish repos with no remotes from repos with unreachable remotes.
 */
async function hasRemoteRefs(repoDir: string): Promise<boolean> {
  try {
    const result = await execa(
      "git",
      ["for-each-ref", "--count=1", "--format=x", "refs/remotes/"],
      {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "inherit"],
      }
    );
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
