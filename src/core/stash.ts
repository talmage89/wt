import { parse, stringify } from "smol-toml";
import { readFile, writeFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { encodeBranch } from "./branch-encode.js";
import * as git from "./git.js";

export interface StashMetadata {
  branch: string;           // original branch name
  commit: string;           // commit hash the branch was on at eviction
  stash_ref: string;        // the stash commit hash
  created_at: string;       // ISO 8601
  last_used_at: string;     // ISO 8601 — reset on each `wt` checkout of this branch
  status: "active" | "archived";
  archived_at?: string;     // ISO 8601, set when archived
  archive_path?: string;    // path to .patch.zst file, set when archived
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
    data["archived_at"] = meta.archived_at;
  }
  if (meta.archive_path !== undefined) {
    data["archive_path"] = meta.archive_path;
  }
  return data;
}

function parseMetadata(parsed: Record<string, unknown>): StashMetadata {
  return {
    branch: typeof parsed["branch"] === "string" ? parsed["branch"] : "",
    commit: typeof parsed["commit"] === "string" ? parsed["commit"] : "",
    stash_ref: typeof parsed["stash_ref"] === "string" ? parsed["stash_ref"] : "",
    created_at:
      typeof parsed["created_at"] === "string"
        ? parsed["created_at"]
        : new Date(0).toISOString(),
    last_used_at:
      typeof parsed["last_used_at"] === "string"
        ? parsed["last_used_at"]
        : new Date(0).toISOString(),
    status: parsed["status"] === "archived" ? "archived" : "active",
    archived_at:
      typeof parsed["archived_at"] === "string" ? parsed["archived_at"] : undefined,
    archive_path:
      typeof parsed["archive_path"] === "string" ? parsed["archive_path"] : undefined,
  };
}

/**
 * Save dirty state for a branch being evicted from a slot.
 * 1. `git stash create --include-untracked` in the worktree
 * 2. Anchor with `git update-ref refs/wt/stashes/<encoded> <hash>`
 * 3. Write metadata TOML to `.wt/stashes/<encoded>.toml`
 * Returns true if a stash was created, false if worktree was clean.
 */
export async function saveStash(
  wtDir: string,
  repoDir: string,
  branch: string,
  worktreeDir: string
): Promise<boolean> {
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

  await writeFile(
    stashFilePath(wtDir, branch),
    stringify(serializeMetadata(meta)),
    "utf8"
  );
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
  worktreeDir: string
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
    process.stderr.write(
      `wt: Stash for ${branch} produced conflicts. Resolve manually.\n`
    );
    process.stderr.write(
      `wt: Run 'wt stash drop ${branch}' after resolution, or 'wt stash show ${branch}' to inspect.\n`
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
export async function getStash(
  wtDir: string,
  branch: string
): Promise<StashMetadata | null> {
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
export async function dropStash(
  wtDir: string,
  repoDir: string,
  branch: string
): Promise<void> {
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
export async function showStash(
  repoDir: string,
  stashRef: string
): Promise<string> {
  return git.stashShow(repoDir, stashRef);
}

/**
 * Update `last_used_at` for a stash (called when branch is checked out via wt).
 */
export async function touchStash(wtDir: string, branch: string): Promise<void> {
  const meta = await getStash(wtDir, branch);
  if (!meta) return;

  meta.last_used_at = new Date().toISOString();
  await writeFile(
    stashFilePath(wtDir, branch),
    stringify(serializeMetadata(meta)),
    "utf8"
  );
}
