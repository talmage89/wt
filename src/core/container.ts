import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ContainerPaths {
  container: string; // the parent directory holding .wt/ and slots
  wtDir: string; // absolute path to .wt/
  repoDir: string; // absolute path to .wt/repo/
}

/**
 * Check if a path exists and is a directory.
 */
async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` looking for a directory that contains `.wt/`.
 * Returns null if not inside a managed container.
 */
export async function findContainer(startDir: string): Promise<ContainerPaths | null> {
  let dir = resolve(startDir);

  while (true) {
    const wtDir = join(dir, ".wt");
    if (await isDir(wtDir)) {
      return {
        container: dir,
        wtDir,
        repoDir: join(wtDir, "repo"),
      };
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Create the .wt/ directory structure inside `containerDir`.
 * Creates: .wt/, .wt/repo/, .wt/stashes/, .wt/stashes/archive/,
 *          .wt/shared/, .wt/templates/, .wt/hooks/
 * Returns the path to .wt/.
 */
export async function createContainerStructure(containerDir: string): Promise<string> {
  const wtDir = join(containerDir, ".wt");

  const dirs = [
    wtDir,
    join(wtDir, "repo"),
    join(wtDir, "stashes"),
    join(wtDir, "stashes", "archive"),
    join(wtDir, "shared"),
    join(wtDir, "templates"),
    join(wtDir, "hooks"),
  ];

  for (const d of dirs) {
    await mkdir(d, { recursive: true });
  }

  return wtDir;
}

/**
 * Validate that the container is not corrupted.
 * Checks that .wt/repo/ exists.
 * Throws a user-facing error if the container is missing its repo.
 */
export async function validateContainer(paths: ContainerPaths): Promise<void> {
  if (!(await isDir(paths.repoDir))) {
    throw new Error("Container is corrupted: .wt/repo/ is missing.");
  }
}

/**
 * Determine which worktree slot the given directory is inside, if any.
 * Returns the slot name (directory name) or null.
 */
export function currentSlotName(startDir: string, containerPaths: ContainerPaths): string | null {
  const container = resolve(containerPaths.container);
  let dir = resolve(startDir);

  // Walk up from startDir until we reach the container level
  while (true) {
    const parent = dirname(dir);
    if (parent === container) {
      // dir is a direct child of container — check it's not .wt itself
      const name = dir.slice(container.length + 1);
      if (name !== ".wt") {
        return name;
      }
      return null;
    }
    if (parent === dir) {
      // Reached filesystem root without finding container
      return null;
    }
    dir = parent;
  }
}
