import { open, unlink } from "fs/promises";
import { join } from "path";
import { constants } from "fs";

/**
 * Acquire an advisory lock on .wt/lock using O_EXCL (atomic create).
 * If the lock is already held, throws a user-facing error.
 * Returns a release function that removes the lock file.
 *
 * Usage:
 *   const release = await acquireLock(paths.wtDir);
 *   try { ... } finally { await release(); }
 */
export async function acquireLock(
  wtDir: string
): Promise<() => Promise<void>> {
  const lockPath = join(wtDir, "lock");

  let fd: Awaited<ReturnType<typeof open>>;
  try {
    fd = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Another wt operation is in progress. If this is stale, remove .wt/lock."
      );
    }
    throw err;
  }

  // Write PID for debugging
  try {
    await fd.writeFile(String(process.pid));
  } finally {
    await fd.close();
  }

  return async () => {
    try {
      await unlink(lockPath);
    } catch {
      // Ignore errors during cleanup (e.g., already removed)
    }
  };
}
