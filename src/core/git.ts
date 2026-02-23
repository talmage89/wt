import { execa } from "execa";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `git fetch --all --prune` in the repo directory.
 */
export async function fetch(repoDir: string): Promise<void> {
  await execa("git", ["fetch", "--all", "--prune"], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git worktree add --detach <path> <commit>`.
 */
export async function worktreeAdd(
  repoDir: string,
  worktreePath: string,
  commit: string
): Promise<void> {
  await execa("git", ["worktree", "add", "--detach", worktreePath, commit], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git checkout <branch>` in a worktree.
 */
export async function checkout(
  worktreeDir: string,
  branch: string
): Promise<void> {
  await execa("git", ["checkout", branch], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git checkout --detach` in a worktree.
 */
export async function checkoutDetach(worktreeDir: string): Promise<void> {
  await execa("git", ["checkout", "--detach"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Save dirty state (staged, unstaged, AND untracked files) as a stash commit.
 * Uses `git stash push --include-untracked` which correctly creates a 3-parent
 * stash commit that includes untracked files. Also cleans the working tree.
 * Returns the stash commit hash, or null if working tree is clean.
 *
 * Note: `git stash create --include-untracked` does NOT include untracked files
 * despite its flag name — only `git stash push --include-untracked` does.
 */
export async function stashCreate(worktreeDir: string): Promise<string | null> {
  // Pre-check: if nothing to stash, return early (stash push exits 0 but
  // doesn't create a ref, making rev-parse fail).
  const statusResult = await execa("git", ["status", "--porcelain"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (statusResult.stdout.trim() === "") return null;

  // Create the stash — this also cleans the working tree.
  await execa("git", ["stash", "push", "--include-untracked"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });

  // Read the stash commit hash from refs/stash.
  const revResult = await execa("git", ["rev-parse", "refs/stash"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const hash = revResult.stdout.trim();
  if (!hash) return null;

  // Drop from the stash stack — we anchor with refs/wt/stashes/* instead,
  // so the stash stack doesn't grow unboundedly.
  await execa("git", ["stash", "drop"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });

  return hash;
}

/**
 * Run `git stash apply <ref>`.
 * Returns { success, conflicted }.
 */
export async function stashApply(
  worktreeDir: string,
  ref: string
): Promise<{ success: boolean; conflicted: boolean }> {
  try {
    await execa("git", ["stash", "apply", ref], {
      cwd: worktreeDir,
      stdio: ["ignore", "pipe", "inherit"],
    });
    return { success: true, conflicted: false };
  } catch (err: unknown) {
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (exitCode === 1) {
      // Exit code 1 from git stash apply typically means conflicts
      return { success: false, conflicted: true };
    }
    throw err;
  }
}

/**
 * Run `git stash show -p --include-untracked <ref>`.
 */
export async function stashShow(repoDir: string, ref: string): Promise<string> {
  const result = await execa(
    "git",
    ["stash", "show", "-p", "--include-untracked", ref],
    {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  return result.stdout;
}

/**
 * Run `git update-ref <refName> <hash>`.
 */
export async function updateRef(
  repoDir: string,
  refName: string,
  hash: string
): Promise<void> {
  await execa("git", ["update-ref", refName, hash], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git update-ref -d <refName>`.
 */
export async function deleteRef(
  repoDir: string,
  refName: string
): Promise<void> {
  await execa("git", ["update-ref", "-d", refName], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git status --porcelain`.
 * Returns raw output (empty string = clean working tree).
 */
export async function status(worktreeDir: string): Promise<string> {
  const result = await execa("git", ["status", "--porcelain"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return result.stdout;
}

/**
 * Detect the symbolic name of HEAD.
 * Returns branch name, or null if HEAD is detached.
 */
export async function currentBranch(
  worktreeDir: string
): Promise<string | null> {
  try {
    const result = await execa(
      "git",
      ["symbolic-ref", "--short", "HEAD"],
      {
        cwd: worktreeDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const branch = result.stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    // Detached HEAD: symbolic-ref exits with non-zero
    return null;
  }
}

/**
 * Detect the remote default branch (e.g., "main" or "master").
 * Tries multiple detection strategies:
 * 1. refs/remotes/origin/HEAD (set by `git remote set-head origin --auto`)
 * 2. Check for refs/remotes/origin/main
 * 3. Check for refs/remotes/origin/master
 * 4. Enumerate all refs/remotes/origin/* and pick the first
 */
export async function defaultBranch(repoDir: string): Promise<string> {
  // 1. Try symbolic-ref for origin/HEAD
  try {
    const result = await execa(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const ref = result.stdout.trim();
    if (ref) return ref.replace(/^origin\//, "");
  } catch {
    // Fall through to next strategy
  }

  // 2. Check if "main" exists on remote
  try {
    await execa("git", ["show-ref", "--verify", "refs/remotes/origin/main"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "main";
  } catch {
    // Fall through
  }

  // 3. Check if "master" exists on remote
  try {
    await execa("git", ["show-ref", "--verify", "refs/remotes/origin/master"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "master";
  } catch {
    // Fall through
  }

  // 4. Enumerate all remote branches and pick the first one
  try {
    const result = await execa(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"],
      {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const branches = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== "origin/HEAD");
    if (branches.length > 0) {
      return branches[0].replace(/^origin\//, "");
    }
  } catch {
    // Fall through
  }

  throw new Error(
    "Could not detect remote default branch. No remote branches found."
  );
}

/**
 * Check if a branch exists on the remote.
 */
export async function remoteBranchExists(
  repoDir: string,
  branch: string
): Promise<boolean> {
  try {
    await execa(
      "git",
      ["show-ref", "--verify", `refs/remotes/origin/${branch}`],
      {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * List all local branches.
 */
export async function listLocalBranches(repoDir: string): Promise<string[]> {
  const result = await execa(
    "git",
    ["branch", "--format=%(refname:short)"],
    {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * List all remote branches (without the "origin/" prefix).
 */
export async function listRemoteBranches(repoDir: string): Promise<string[]> {
  const result = await execa(
    "git",
    ["branch", "-r", "--format=%(refname:short)"],
    {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.includes("HEAD"));
}

/**
 * Run `git worktree list --porcelain`.
 */
export async function worktreeList(
  repoDir: string
): Promise<Array<{ path: string; head: string; branch: string | null }>> {
  const result = await execa("git", ["worktree", "list", "--porcelain"], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const worktrees: Array<{
    path: string;
    head: string;
    branch: string | null;
  }> = [];
  let current: Partial<{ path: string; head: string; branch: string | null }> =
    {};

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path !== undefined) {
        worktrees.push({
          path: current.path,
          head: current.head ?? "",
          branch: current.branch ?? null,
        });
      }
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      // Strip "refs/heads/" prefix
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = null;
    } else if (line === "") {
      if (current.path !== undefined) {
        worktrees.push({
          path: current.path,
          head: current.head ?? "",
          branch: current.branch ?? null,
        });
        current = {};
      }
    }
  }

  if (current.path !== undefined) {
    worktrees.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
    });
  }

  return worktrees;
}

/**
 * Run `git ls-files <path>` to check if a file is tracked.
 */
export async function isTracked(
  worktreeDir: string,
  filePath: string
): Promise<boolean> {
  const result = await execa("git", ["ls-files", "--error-unmatch", filePath], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "pipe"],
    reject: false,
  });
  return result.exitCode === 0;
}

/**
 * Run `git rev-parse --show-toplevel` to get repo root.
 */
export async function repoRoot(dir: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return result.stdout.trim();
}

/**
 * Clone a bare repo.
 */
export async function cloneBare(url: string, dest: string): Promise<void> {
  await execa("git", ["clone", "--bare", url, dest], {
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Get the commit hash for HEAD. */
export async function currentCommit(dir: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return result.stdout.trim();
}

/** Set a git config value in the repo. */
export async function setConfig(
  repoDir: string,
  key: string,
  value: string
): Promise<void> {
  await execa("git", ["config", key, value], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git checkout -b <branch> --track origin/<branch>` in a worktree.
 * Used to create a local tracking branch from a remote branch.
 */
export async function checkoutTrack(
  worktreeDir: string,
  branch: string
): Promise<void> {
  await execa(
    "git",
    ["checkout", "-b", branch, "--track", `origin/${branch}`],
    {
      cwd: worktreeDir,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
}

/**
 * Run `git reset --hard HEAD` to discard all tracked file changes.
 */
export async function hardReset(worktreeDir: string): Promise<void> {
  await execa("git", ["reset", "--hard", "HEAD"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git clean -fd` to remove untracked files and directories.
 */
export async function cleanUntracked(worktreeDir: string): Promise<void> {
  await execa("git", ["clean", "-fd"], {
    cwd: worktreeDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Add a named remote to the repo. */
export async function addRemote(
  repoDir: string,
  name: string,
  url: string
): Promise<void> {
  await execa("git", ["remote", "add", name, url], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git worktree remove --force <path>`.
 * Removes the worktree directory and its git metadata.
 * Uses --force to handle any remaining state after stash+clean.
 */
export async function worktreeRemove(
  repoDir: string,
  worktreePath: string
): Promise<void> {
  await execa("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Run `git worktree prune` to clean up stale worktree registrations.
 */
export async function worktreePrune(repoDir: string): Promise<void> {
  await execa("git", ["worktree", "prune"], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * Check if a git ref exists (e.g., refs/remotes/origin/main).
 */
export async function refExists(repoDir: string, ref: string): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--verify", ref], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
