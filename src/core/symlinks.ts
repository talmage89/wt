import { access, lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { SharedConfig } from "./config.js";
import * as git from "./git.js";

/**
 * Walk a directory recursively, yielding file paths relative to rootDir.
 * Only yields files (not directories).
 */
async function* walkFiles(rootDir: string, subDir = ""): AsyncGenerator<string> {
  const dir = subDir ? join(rootDir, subDir) : rootDir;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const entry of entries) {
    const rel = subDir ? join(subDir, entry) : entry;
    const full = join(rootDir, rel);
    let st: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkFiles(rootDir, rel);
    } else {
      yield rel;
    }
  }
}

/**
 * Check if a file path is tracked by git in the given worktree.
 */
export async function isGitTracked(worktreeDir: string, relativePath: string): Promise<boolean> {
  return git.isTracked(worktreeDir, relativePath);
}

/**
 * Establish or fix a single symlink from a worktree file to its canonical copy.
 * - If the file is git-tracked in this worktree's branch: skip, warn.
 * - If a real file (not symlink) exists at the target: leave it (sync handles migration).
 * - If no file exists at the target: create the symlink.
 * - If a symlink exists but points elsewhere: fix it.
 * - If a symlink exists and is correct: skip.
 */
async function establishOneSymlink(
  wtDir: string,
  worktreeDir: string,
  relativeToWorktree: string,
  branch: string,
): Promise<void> {
  const canonicalPath = join(wtDir, "shared", relativeToWorktree);
  const targetPath = join(worktreeDir, relativeToWorktree);
  const relativeLinkTarget = relative(dirname(targetPath), canonicalPath);

  // Check git-tracked conflict
  if (await isGitTracked(worktreeDir, relativeToWorktree)) {
    process.stderr.write(
      `wt: Skipping symlink for ${relativeToWorktree}: file is tracked by git in branch ${branch}.\n`,
    );
    return;
  }

  // Check current state at targetPath
  let st = null;
  try {
    st = await lstat(targetPath);
  } catch {
    // targetPath doesn't exist
  }

  if (st === null) {
    // No file — create parent dirs and symlink
    await mkdir(dirname(targetPath), { recursive: true });
    await symlink(relativeLinkTarget, targetPath);
  } else if (st.isSymbolicLink()) {
    // Check if it points to the right place
    const current = await readlink(targetPath);
    if (current !== relativeLinkTarget) {
      await rm(targetPath);
      await symlink(relativeLinkTarget, targetPath);
    }
    // else: already correct, skip
  }
}

/**
 * Establish symlinks for a single worktree slot.
 * Handles both shared directories (recursive) and individual shared files.
 */
export async function establishSymlinks(
  wtDir: string,
  worktreeDir: string,
  shared: SharedConfig,
  branch: string,
): Promise<void> {
  // Shared directories: walk each canonical dir and link every file
  for (const sharedDir of shared.directories) {
    const canonicalDir = join(wtDir, "shared", sharedDir);

    // Check if canonical dir exists
    try {
      await lstat(canonicalDir);
    } catch {
      continue; // nothing to link
    }

    for await (const file of walkFiles(canonicalDir)) {
      await establishOneSymlink(wtDir, worktreeDir, join(sharedDir, file), branch);
    }
  }

  // Individual shared files
  for (const file of shared.files) {
    const canonicalPath = join(wtDir, "shared", file);
    try {
      await lstat(canonicalPath);
    } catch {
      continue; // canonical file doesn't exist yet
    }
    await establishOneSymlink(wtDir, worktreeDir, file, branch);
  }
}

/**
 * Migrate a single real (non-symlink, non-git-tracked) file from a worktree
 * to the canonical location in `.wt/shared/` and replace it with a symlink.
 */
async function migrateOneFile(
  wtDir: string,
  worktreeDir: string,
  relativeToWorktree: string,
): Promise<void> {
  const fullPath = join(worktreeDir, relativeToWorktree);
  let st: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    st = await lstat(fullPath);
  } catch {
    return;
  }

  if (st.isSymbolicLink() || !st.isFile()) return;
  if (await isGitTracked(worktreeDir, relativeToWorktree)) return;

  const canonicalPath = join(wtDir, "shared", relativeToWorktree);
  await mkdir(dirname(canonicalPath), { recursive: true });

  let canonicalExists = false;
  try {
    await lstat(canonicalPath);
    canonicalExists = true;
  } catch {
    // canonical doesn't exist
  }

  if (!canonicalExists) {
    await rename(fullPath, canonicalPath);
  } else {
    await rm(fullPath);
  }

  const relativeLinkTarget = relative(dirname(fullPath), canonicalPath);
  await symlink(relativeLinkTarget, fullPath);
}

/**
 * Remove a symlink if it is broken (target no longer exists).
 */
async function cleanBrokenSymlink(fullPath: string): Promise<void> {
  let st: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    st = await lstat(fullPath);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      await access(fullPath); // follows symlink — if target missing, throws
    } catch {
      await rm(fullPath); // broken symlink
    }
  }
}

/**
 * Full sync across all worktrees.
 * For each configured shared directory and individual file, for each worktree slot:
 *   1. If a real file exists in the worktree (not symlink, not git-tracked):
 *      Move it to `.wt/shared/` and replace with symlink.
 *   2. If a file exists in `.wt/shared/` but worktree lacks the symlink:
 *      Create the symlink (respecting git-tracked precedence).
 *   3. If a symlink is broken (target deleted): remove it.
 */
export async function syncAllSymlinks(
  wtDir: string,
  containerDir: string,
  slots: Record<string, { branch: string | null }>,
  shared: SharedConfig,
): Promise<void> {
  // --- Shared directories ---
  for (const sharedDir of shared.directories) {
    const canonicalDir = join(wtDir, "shared", sharedDir);

    // STEP 1: Migrate real files to canonical location
    for (const slotName of Object.keys(slots)) {
      const worktreeDir = join(containerDir, slotName);
      const worktreeSharedDir = join(worktreeDir, sharedDir);

      let worktreeSharedExists = false;
      try {
        await lstat(worktreeSharedDir);
        worktreeSharedExists = true;
      } catch {
        // directory doesn't exist — skip migration step
      }

      if (!worktreeSharedExists) continue;

      for await (const file of walkFiles(worktreeSharedDir)) {
        await migrateOneFile(wtDir, worktreeDir, join(sharedDir, file));
      }
    }

    // STEP 2: Propagate canonical files to all worktrees
    for (const [slotName, slotState] of Object.entries(slots)) {
      const worktreeDir = join(containerDir, slotName);
      const branch = slotState.branch ?? "(detached)";
      // Walk the canonical dir and establish each file
      try {
        await lstat(canonicalDir);
      } catch {
        continue;
      }
      for await (const file of walkFiles(canonicalDir)) {
        await establishOneSymlink(wtDir, worktreeDir, join(sharedDir, file), branch);
      }
    }

    // STEP 3: Clean broken symlinks in all worktrees
    for (const slotName of Object.keys(slots)) {
      const worktreeDir = join(containerDir, slotName);
      const worktreeSharedDir = join(worktreeDir, sharedDir);

      let worktreeSharedExists = false;
      try {
        await lstat(worktreeSharedDir);
        worktreeSharedExists = true;
      } catch {
        // directory doesn't exist — skip
      }

      if (!worktreeSharedExists) continue;

      for await (const file of walkFiles(worktreeSharedDir)) {
        await cleanBrokenSymlink(join(worktreeSharedDir, file));
      }
    }
  }

  // --- Individual shared files ---
  for (const file of shared.files) {
    // STEP 1: Migrate real files
    for (const slotName of Object.keys(slots)) {
      const worktreeDir = join(containerDir, slotName);
      await migrateOneFile(wtDir, worktreeDir, file);
    }

    // STEP 2: Propagate
    for (const [slotName, slotState] of Object.entries(slots)) {
      const worktreeDir = join(containerDir, slotName);
      const branch = slotState.branch ?? "(detached)";
      const canonicalPath = join(wtDir, "shared", file);
      try {
        await lstat(canonicalPath);
      } catch {
        continue;
      }
      await establishOneSymlink(wtDir, worktreeDir, file, branch);
    }

    // STEP 3: Clean broken symlinks
    for (const slotName of Object.keys(slots)) {
      const worktreeDir = join(containerDir, slotName);
      await cleanBrokenSymlink(join(worktreeDir, file));
    }
  }
}

/**
 * Remove a single managed symlink if it points to the expected canonical location.
 */
async function removeOneSymlink(
  wtDir: string,
  worktreeDir: string,
  relativeToWorktree: string,
): Promise<void> {
  const fullPath = join(worktreeDir, relativeToWorktree);
  let st: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    st = await lstat(fullPath);
  } catch {
    return;
  }

  if (st.isSymbolicLink()) {
    const canonicalPath = join(wtDir, "shared", relativeToWorktree);
    const expectedTarget = relative(dirname(fullPath), canonicalPath);
    try {
      const current = await readlink(fullPath);
      if (current === expectedTarget) {
        await rm(fullPath);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Remove all shared symlinks from a worktree (used during cleanup).
 */
export async function removeSymlinks(
  wtDir: string,
  worktreeDir: string,
  shared: SharedConfig,
): Promise<void> {
  // Shared directories
  for (const sharedDir of shared.directories) {
    const worktreeSharedDir = join(worktreeDir, sharedDir);

    try {
      await lstat(worktreeSharedDir);
    } catch {
      continue; // doesn't exist
    }

    for await (const file of walkFiles(worktreeSharedDir)) {
      await removeOneSymlink(wtDir, worktreeDir, join(sharedDir, file));
    }
  }

  // Individual shared files
  for (const file of shared.files) {
    await removeOneSymlink(wtDir, worktreeDir, file);
  }
}
