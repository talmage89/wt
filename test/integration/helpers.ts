import { execa } from "execa";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContainerPaths } from "../../src/core/container.js";

/**
 * Create a temporary directory for a test.
 */
export async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wt-test-"));
}

/**
 * Configure git user identity in a repo (required for commits).
 */
async function configureGitUser(dir: string): Promise<void> {
  await execa("git", ["config", "user.email", "test@wt.test"], { cwd: dir });
  await execa("git", ["config", "user.name", "WT Test"], { cwd: dir });
}

/**
 * Create a git repo with an initial commit on 'main'.
 * Returns the path to the repo.
 */
export async function createTestRepo(dir: string): Promise<string> {
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await configureGitUser(dir);
  await fs.writeFile(path.join(dir, "README.md"), "# Test\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "Initial commit"], { cwd: dir });
  return dir;
}

/**
 * Create a bare git repo with an initial commit on 'main'.
 * Useful as a fake remote for URL-based init.
 */
export async function createBareRemote(dir: string): Promise<string> {
  // Create a non-bare repo first so we can commit
  const workDir = await createTempDir();
  await execa("git", ["init", "-b", "main"], { cwd: workDir });
  await configureGitUser(workDir);
  await fs.writeFile(path.join(workDir, "README.md"), "# Remote\n");
  await execa("git", ["add", "."], { cwd: workDir });
  await execa("git", ["commit", "-m", "Initial commit"], { cwd: workDir });

  // Clone bare into the target dir (git will create dir if needed)
  await fs.rm(dir, { recursive: true, force: true });
  await execa("git", ["clone", "--bare", workDir, dir]);
  await fs.rm(workDir, { recursive: true, force: true });
  return dir;
}

/**
 * Create a branch with a file commit in a repo.
 * Switches back to original branch after creating.
 */
export async function createBranch(
  repoDir: string,
  branch: string,
  file: string,
  content: string
): Promise<void> {
  const currentBranch = (
    await execa("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoDir })
  ).stdout.trim();

  await execa("git", ["checkout", "-b", branch], { cwd: repoDir });
  await fs.writeFile(path.join(repoDir, file), content);
  await execa("git", ["add", "."], { cwd: repoDir });
  await execa("git", ["commit", "-m", `Add ${file}`], { cwd: repoDir });
  await execa("git", ["checkout", currentBranch], { cwd: repoDir });
}

/**
 * Clean up a temp directory.
 */
export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Build ContainerPaths from a container directory.
 */
export function containerPaths(containerDir: string): ContainerPaths {
  return {
    container: containerDir,
    wtDir: path.join(containerDir, ".wt"),
    repoDir: path.join(containerDir, ".wt", "repo"),
  };
}

/**
 * Check if a path exists.
 */
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
