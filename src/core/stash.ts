import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { parse, stringify } from "smol-toml";
import { encodeBranch } from "./branch-encode.js";
import * as git from "./git.js";
import { removeSymlinks } from "./symlinks.js";

export interface StashMetadata {
  branch: string; // original branch name
  commit: string; // commit hash the branch was on at eviction
  stash_ref: string; // the stash commit hash
  created_at: string; // ISO 8601
  last_used_at: string; // ISO 8601 — reset on each `wt` checkout of this branch
  status: "active" | "archived";
  archived_at?: string; // ISO 8601, set when archived
  archive_path?: string; // path to .patch.zst file, set when archived
}

function stashFilePath(wtDir: string, branch: string): string {
  return join(wtDir, "stashes", `${encodeBranch(branch)}.toml`);
}

function serializeMetadata(meta: StashMetadata): Record<string, unknown> {
  const data: Record<string, unknown> = {
    branch: meta.branch,
    commit: meta.commit,
    stash_ref: meta.stash_ref,
    created_at: meta.created_at,
    last_used_at: meta.last_used_at,
    status: meta.status,
  };
  if (meta.archived_at !== undefined) {
    data.archived_at = meta.archived_at;
  }
  if (meta.archive_path !== undefined) {
    data.archive_path = meta.archive_path;
  }
  return data;
}

function parseMetadata(parsed: Record<string, unknown>): StashMetadata {
  return {
    branch: typeof parsed.branch === "string" ? parsed.branch : "",
    commit: typeof parsed.commit === "string" ? parsed.commit : "",
    stash_ref: typeof parsed.stash_ref === "string" ? parsed.stash_ref : "",
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date(0).toISOString(),
    last_used_at:
      typeof parsed.last_used_at === "string" ? parsed.last_used_at : new Date(0).toISOString(),
    status: parsed.status === "archived" ? "archived" : "active",
    archived_at: typeof parsed.archived_at === "string" ? parsed.archived_at : undefined,
    archive_path: typeof parsed.archive_path === "string" ? parsed.archive_path : undefined,
  };
}

/**
 * Save dirty state for a branch being evicted from a slot.
 * 1. Remove managed shared symlinks so they are not captured in the stash.
 *    (They are always recreated by wt sync / establishSymlinks on checkout.)
 * 2. `git stash push --include-untracked` in the worktree
 * 3. Anchor with `git update-ref refs/wt/stashes/<encoded> <hash>`
 * 4. Write metadata TOML to `.wt/stashes/<encoded>.toml`
 * Returns true if a stash was created, false if worktree was clean.
 */
export async function saveStash(
  wtDir: string,
  repoDir: string,
  branch: string,
  worktreeDir: string,
  sharedDirs: string[] = [],
): Promise<boolean> {
  // Remove managed shared symlinks before stashing — they are wt infrastructure,
  // not user state, and are always recreated on checkout. Including them in the
  // stash causes "already exists, no checkout" errors on stash apply (BUG-007).
  if (sharedDirs.length > 0) {
    await removeSymlinks(wtDir, worktreeDir, sharedDirs);
  }

  const hash = await git.stashCreate(worktreeDir);
  if (!hash) return false;

  const encoded = encodeBranch(branch);
  await git.updateRef(repoDir, `refs/wt/stashes/${encoded}`, hash);

  const commit = await git.currentCommit(worktreeDir);
  const now = new Date().toISOString();

  const meta: StashMetadata = {
    branch,
    commit,
    stash_ref: hash,
    created_at: now,
    last_used_at: now,
    status: "active",
  };

  // BUG-032: ensure .wt/stashes/ exists in case it was deleted after init
  await mkdir(join(wtDir, "stashes"), { recursive: true });
  await writeFile(stashFilePath(wtDir, branch), stringify(serializeMetadata(meta)), "utf8");
  return true;
}

/**
 * Restore a stash for a branch that was just checked out.
 * 1. Read metadata from `.wt/stashes/<encoded>.toml`
 * 2. `git stash apply <stash_ref>` in the worktree
 * 3. On success: delete ref + metadata file
 * 4. On conflict: warn, retain ref + metadata
 * Returns: "restored" | "conflict" | "none" (no stash exists)
 */
export async function restoreStash(
  wtDir: string,
  repoDir: string,
  branch: string,
  worktreeDir: string,
): Promise<"restored" | "conflict" | "none"> {
  const meta = await getStash(wtDir, branch);
  if (!meta || meta.status === "archived") return "none";

  const result = await git.stashApply(worktreeDir, meta.stash_ref);

  if (result.success && !result.conflicted) {
    await git.deleteRef(repoDir, `refs/wt/stashes/${encodeBranch(branch)}`);
    try {
      await unlink(stashFilePath(wtDir, branch));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return "restored";
  }

  if (result.conflicted) {
    process.stderr.write(`wt: Stash for ${branch} produced conflicts. Resolve manually.\n`);
    process.stderr.write(
      `wt: Run 'wt stash drop ${branch}' after resolution, or 'wt stash show ${branch}' to inspect.\n`,
    );
    return "conflict";
  }

  return "none";
}

/**
 * List all stash metadata files.
 */
export async function listStashes(wtDir: string): Promise<StashMetadata[]> {
  const stashesDir = join(wtDir, "stashes");
  let files: string[];
  try {
    files = await readdir(stashesDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: StashMetadata[] = [];
  for (const file of files) {
    if (!file.endsWith(".toml")) continue;
    try {
      const raw = await readFile(join(stashesDir, file), "utf8");
      const parsed = parse(raw) as Record<string, unknown>;
      results.push(parseMetadata(parsed));
    } catch {
      // Skip malformed files
    }
  }
  return results;
}

/**
 * Read stash metadata for a specific branch.
 */
export async function getStash(wtDir: string, branch: string): Promise<StashMetadata | null> {
  try {
    const raw = await readFile(stashFilePath(wtDir, branch), "utf8");
    const parsed = parse(raw) as Record<string, unknown>;
    return parseMetadata(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Delete a stash (ref + metadata + archive file if present).
 */
export async function dropStash(wtDir: string, repoDir: string, branch: string): Promise<void> {
  const meta = await getStash(wtDir, branch);
  if (!meta) return;

  // Delete git ref (ignore if already gone)
  try {
    await git.deleteRef(repoDir, `refs/wt/stashes/${encodeBranch(branch)}`);
  } catch {
    // Ref may not exist
  }

  // Delete archive file if present (best effort)
  if (meta.archive_path) {
    try {
      await unlink(meta.archive_path);
    } catch {
      // Best effort
    }
  }

  // Delete metadata file
  try {
    await unlink(stashFilePath(wtDir, branch));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Show stash diff contents.
 */
export async function showStash(repoDir: string, stashRef: string): Promise<string> {
  return git.stashShow(repoDir, stashRef);
}

/**
 * Update `last_used_at` for a stash (called when branch is checked out via wt).
 */
export async function touchStash(wtDir: string, branch: string): Promise<void> {
  const meta = await getStash(wtDir, branch);
  if (!meta) return;

  meta.last_used_at = new Date().toISOString();
  await writeFile(stashFilePath(wtDir, branch), stringify(serializeMetadata(meta)), "utf8");
}

/**
 * Check if the zstd binary is available on this system.
 */
export async function isZstdAvailable(): Promise<boolean> {
  try {
    await execa("zstd", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Archive a single active stash:
 * 1. Export patch via `git diff --binary <commit> <stash_ref>` (bare-repo safe)
 * 2. Compress with zstd (or store uncompressed if zstd unavailable)
 * 3. Delete git ref
 * 4. Update metadata: status="archived", archived_at, archive_path
 */
export async function archiveStash(
  wtDir: string,
  repoDir: string,
  branch: string,
  opts?: { useZstd?: boolean },
): Promise<void> {
  const meta = await getStash(wtDir, branch);
  if (!meta || meta.status !== "active") return;

  const encoded = encodeBranch(branch);
  const archiveDir = join(wtDir, "stashes", "archive");
  await mkdir(archiveDir, { recursive: true });

  // Export patch via git diff --binary (works in bare repos).
  // git stash show requires a work tree and always fails on bare repos (BUG-008).
  const diffResult = await execa("git", ["diff", "--binary", meta.commit, meta.stash_ref], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let patch = diffResult.stdout;

  // BUG-014: Stashes created with `git stash push --include-untracked` store
  // untracked files in a third parent. `git diff` above only captures tracked
  // file changes. Check for a third parent and append its contents.
  try {
    await execa("git", ["rev-parse", "--verify", `${meta.stash_ref}^3`], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Third parent exists — export untracked files.
    // The third parent is a root commit (no parents), so --root is required
    // to produce a diff against the empty tree showing all files as additions.
    const untrackedResult = await execa(
      "git",
      ["diff-tree", "--root", "-r", "-p", "--binary", "--no-commit-id", `${meta.stash_ref}^3`],
      { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (untrackedResult.stdout) {
      patch += `\n# --- untracked files ---\n${untrackedResult.stdout}`;
    }
  } catch {
    // No third parent — stash has no untracked files, nothing to append
  }

  let archivePath: string;
  const useZstd = opts?.useZstd ?? (await isZstdAvailable());
  if (useZstd) {
    archivePath = join(archiveDir, `${encoded}.patch.zst`);
    await execa("zstd", ["-f", "-o", archivePath], {
      input: patch,
      stdio: ["pipe", "pipe", "inherit"],
    });
  } else {
    archivePath = join(archiveDir, `${encoded}.patch`);
    await writeFile(archivePath, patch, "utf8");
    process.stderr.write("Warning: zstd not found. Archived stash stored uncompressed.\n");
  }

  // Delete git ref (ignore if already gone)
  try {
    await git.deleteRef(repoDir, `refs/wt/stashes/${encoded}`);
  } catch {
    // Ref may already be deleted
  }

  // Update metadata
  meta.status = "archived";
  meta.archived_at = new Date().toISOString();
  meta.archive_path = archivePath;
  await writeFile(stashFilePath(wtDir, branch), stringify(serializeMetadata(meta)), "utf8");
}

/**
 * Scan all active stashes and archive those that qualify:
 * - Branch does NOT exist on the remote, AND
 * - last_used_at is older than archiveAfterDays days ago
 *
 * Returns lists of archived and skipped branch names.
 *
 * @param excludeBranch - Branch to unconditionally skip (e.g. the branch being
 *   checked out, whose stash must not be archived before it can be restored).
 */
export async function archiveScan(
  wtDir: string,
  repoDir: string,
  archiveAfterDays: number,
  excludeBranch?: string,
): Promise<{ archived: string[]; skipped: string[] }> {
  const stashes = await listStashes(wtDir);
  const activeStashes = stashes.filter((s) => s.status === "active");

  const archived: string[] = [];
  const skipped: string[] = [];

  for (const stash of activeStashes) {
    // Never archive the branch being checked out — its stash must survive until
    // the restore step that follows the archive scan (BUG-021).
    if (excludeBranch !== undefined && stash.branch === excludeBranch) {
      skipped.push(stash.branch);
      continue;
    }

    // Check age: governed by last_used_at (not created_at)
    const lastUsed = new Date(stash.last_used_at);
    const daysSinceUse = (Date.now() - lastUsed.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUse < archiveAfterDays) {
      skipped.push(stash.branch);
      continue;
    }

    // Check remote: branch must NOT exist on remote
    const existsOnRemote = await git.remoteBranchExists(repoDir, stash.branch);
    if (existsOnRemote) {
      skipped.push(stash.branch);
      continue;
    }

    // Both conditions met — archive
    await archiveStash(wtDir, repoDir, stash.branch);
    archived.push(stash.branch);
  }

  return { archived, skipped };
}
