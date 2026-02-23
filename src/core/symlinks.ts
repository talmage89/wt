import {
  readdir,
  lstat,
  mkdir,
  symlink,
  readlink,
  rm,
  rename,
  access,
} from "fs/promises";
import { join, dirname, relative } from "path";
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
    let st;
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
export async function isGitTracked(
  worktreeDir: string,
  relativePath: string
): Promise<boolean> {
  return git.isTracked(worktreeDir, relativePath);
}

/**
 * Establish symlinks for a single worktree slot.
 * For each configured shared directory, for each file in `.wt/shared/<dir>/`:
 *   - If the file is git-tracked in this worktree's branch: skip, warn.
 *   - If a real file (not symlink) exists at the target: leave it (sync handles migration).
 *   - If no file exists at the target: create the symlink.
 *   - If a symlink exists but points elsewhere: fix it.
 *   - If a symlink exists and is correct: skip.
 */
export async function establishSymlinks(
  wtDir: string,
  worktreeDir: string,
  sharedDirs: string[],
  branch: string
): Promise<void> {
  for (const sharedDir of sharedDirs) {
    const canonicalDir = join(wtDir, "shared", sharedDir);

    // Check if canonical dir exists
    try {
      await lstat(canonicalDir);
    } catch {
      continue; // nothing to link
    }

    for await (const file of walkFiles(canonicalDir)) {
      const targetPath = join(worktreeDir, sharedDir, file);
      const canonicalPath = join(canonicalDir, file);
      const relativeLinkTarget = relative(dirname(targetPath), canonicalPath);

      // Check git-tracked conflict
      const relativeToWorktree = join(sharedDir, file);
      if (await isGitTracked(worktreeDir, relativeToWorktree)) {
        process.stderr.write(
          `wt: Skipping symlink for ${relativeToWorktree}: file is tracked by git in branch ${branch}.\n`
        );
        continue;
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
      } else {
        // Real file exists — don't touch it (sync will handle migration)
        continue;
      }
    }
  }
}

/**
 * Full sync across all worktrees.
 * For each configured shared directory, for each worktree slot:
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
  sharedDirs: string[]
): Promise<void> {
  for (const sharedDir of sharedDirs) {
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
        const fullPath = join(worktreeSharedDir, file);
        let st;
        try {
          st = await lstat(fullPath);
        } catch {
          continue;
        }

        if (st.isSymbolicLink()) continue; // already a symlink

        if (st.isFile()) {
          const relativeToWorktree = join(sharedDir, file);
          if (await isGitTracked(worktreeDir, relativeToWorktree)) continue; // git-tracked, don't move

          // Move to canonical
          const canonicalPath = join(canonicalDir, file);
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

          // Create symlink
          const relativeLinkTarget = relative(dirname(fullPath), canonicalPath);
          await symlink(relativeLinkTarget, fullPath);
        }
      }
    }

    // STEP 2: Propagate canonical files to all worktrees
    for (const [slotName, slotState] of Object.entries(slots)) {
      const worktreeDir = join(containerDir, slotName);
      const branch = slotState.branch ?? "(detached)";
      await establishSymlinks(wtDir, worktreeDir, [sharedDir], branch);
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
        const fullPath = join(worktreeSharedDir, file);
        let st;
        try {
          st = await lstat(fullPath);
        } catch {
          continue;
        }

        if (st.isSymbolicLink()) {
          try {
            await access(fullPath); // follows symlink — if target missing, throws
          } catch {
            await rm(fullPath); // broken symlink
          }
        }
      }
    }
  }
}

/**
 * Remove all shared symlinks from a worktree (used during cleanup).
 */
export async function removeSymlinks(
  wtDir: string,
  worktreeDir: string,
  sharedDirs: string[]
): Promise<void> {
  for (const sharedDir of sharedDirs) {
    const worktreeSharedDir = join(worktreeDir, sharedDir);

    try {
      await lstat(worktreeSharedDir);
    } catch {
      continue; // doesn't exist
    }

    for await (const file of walkFiles(worktreeSharedDir)) {
      const fullPath = join(worktreeSharedDir, file);
      let st;
      try {
        st = await lstat(fullPath);
      } catch {
        continue;
      }

      if (st.isSymbolicLink()) {
        // Only remove if it points into .wt/shared/
        const canonicalDir = join(wtDir, "shared", sharedDir);
        const canonicalPath = join(canonicalDir, file);
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
  }
}
