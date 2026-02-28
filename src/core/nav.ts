import { readFile, unlink, writeFile } from "node:fs/promises";

/**
 * Get the nav file path for the current process (uses parent PID).
 */
export function navFilePath(): string {
  return `/tmp/wt-nav-${process.ppid}`;
}

/**
 * Write the target directory to the nav file.
 * Returns the path to the nav file.
 */
export async function writeNavFile(targetDir: string): Promise<string> {
  const path = navFilePath();
  await writeFile(path, `${targetDir}\n`, "utf8");
  return path;
}

/**
 * Read the target directory from a nav file.
 */
export async function readNavFile(navFilePathArg: string): Promise<string> {
  const content = await readFile(navFilePathArg, "utf8");
  return content.trim();
}

/**
 * Delete the nav file. No-op if it doesn't exist.
 */
export async function cleanNavFile(navFilePathArg: string): Promise<void> {
  try {
    await unlink(navFilePathArg);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
