import { describe, it, expect, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { runCheckout } from "../../src/commands/checkout.js";
import { runFetch } from "../../src/commands/fetch.js";
import { runClean } from "../../src/commands/clean.js";
import {
  getStash,
  listStashes,
  dropStash,
  archiveScan,
  archiveStash,
  isZstdAvailable,
} from "../../src/core/stash.js";
import { readState, writeState } from "../../src/core/state.js";
import {
  createTempDir,
  createBareRemote,
  cleanup,
  exists,
} from "./helpers.js";

const temps: string[] = [];

async function mktemp(): Promise<string> {
  const d = await createTempDir();
  temps.push(d);
  return d;
}

afterEach(async () => {
  for (const d of temps.splice(0)) {
    await cleanup(d);
  }
});

/**
 * Create a container initialized from a bare remote.
 * Returns paths and a helper to add branches on the remote.
 */
async function setupRemoteContainer(containerDir: string) {
  const remoteBase = await mktemp();
  const remoteDir = path.join(remoteBase, "remote.git");
  await createBareRemote(remoteDir);

  // Push a feature branch to the remote via a temp clone
  const workDir = await mktemp();
  await execa("git", ["clone", remoteDir, workDir]);
  await execa("git", ["config", "user.email", "test@wt.test"], { cwd: workDir });
  await execa("git", ["config", "user.name", "WT Test"], { cwd: workDir });
  await fs.writeFile(path.join(workDir, "feature.txt"), "feature\n");
  await execa("git", ["add", "."], { cwd: workDir });
  await execa("git", ["commit", "-m", "Add feature"], { cwd: workDir });
  await execa("git", ["checkout", "-b", "feature-branch"], { cwd: workDir });
  await execa("git", ["push", "origin", "feature-branch"], { cwd: workDir });

  await runInit({ url: remoteDir, cwd: containerDir });

  const wtDir = path.join(containerDir, ".wt");
  const repoDir = path.join(containerDir, ".wt", "repo");

  return { remoteDir, wtDir, repoDir };
}

/**
 * Create a stash for 'feature-branch' by making it dirty and evicting it.
 */
async function createStashForFeatureBranch(
  containerDir: string,
  wtDir: string,
  repoDir: string
): Promise<void> {
  // Checkout feature-branch
  await runCheckout({ branch: "feature-branch", cwd: containerDir, noRestore: true });

  // Modify a tracked file to create dirty state
  const state = await readState(wtDir);
  const featureSlot = Object.entries(state.slots).find(
    ([, s]) => s.branch === "feature-branch"
  )?.[0];
  expect(featureSlot).toBeDefined();

  await fs.writeFile(
    path.join(containerDir, featureSlot!, "feature.txt"),
    "modified\n"
  );

  // Force feature-branch to be LRU so it gets evicted
  state.slots[featureSlot!].last_used_at = new Date(0).toISOString();
  await writeState(wtDir, state);

  // Create enough branches to force an eviction of feature-branch
  const slotCount = Object.keys(state.slots).length;
  for (let i = 0; i < slotCount - 1; i++) {
    await execa("git", ["branch", `evict-fill-${i}`], { cwd: repoDir });
    await runCheckout({ branch: `evict-fill-${i}`, cwd: containerDir });
  }

  // One more to evict feature-branch
  await execa("git", ["branch", "final-evict"], { cwd: repoDir });
  await runCheckout({ branch: "final-evict", cwd: containerDir, noRestore: true });

  const stash = await getStash(wtDir, "feature-branch");
  expect(stash).not.toBeNull();
  expect(stash!.status).toBe("active");
}

/**
 * Delete a branch from a bare remote using git push --delete.
 * Then prune the local remote-tracking ref.
 */
async function deleteRemoteBranch(
  remoteDir: string,
  repoDir: string,
  branch: string
): Promise<void> {
  await execa("git", ["branch", "-D", branch], { cwd: remoteDir });
  // Prune stale remote-tracking ref
  await execa("git", ["fetch", "--prune", "origin"], { cwd: repoDir });
}

/**
 * Set a stash's last_used_at to N days ago.
 */
async function ageStash(
  wtDir: string,
  branch: string,
  daysAgo: number
): Promise<void> {
  const meta = await getStash(wtDir, branch);
  expect(meta).not.toBeNull();
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  meta!.last_used_at = past.toISOString();
  // Write directly to the file via writeFile + stringify
  const { stringify } = await import("smol-toml");
  const encoded = (await import("../../src/core/branch-encode.js")).encodeBranch(branch);
  const filePath = path.join(wtDir, "stashes", `${encoded}.toml`);
  await fs.writeFile(filePath, stringify({
    branch: meta!.branch,
    commit: meta!.commit,
    stash_ref: meta!.stash_ref,
    created_at: meta!.created_at,
    last_used_at: meta!.last_used_at,
    status: meta!.status,
  }), "utf8");
}

// ---------------------------------------------------------------------------
// archiveScan: core logic
// ---------------------------------------------------------------------------

describe("archiveScan", () => {
  it("archives a stash when branch is deleted on remote and last_used_at is old enough", async () => {
    const containerDir = await mktemp();
    const { remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);

    // Delete the remote branch
    await deleteRemoteBranch(remoteDir, repoDir, "feature-branch");

    // Age the stash to 8 days ago
    await ageStash(wtDir, "feature-branch", 8);

    const { archived, skipped } = await archiveScan(wtDir, repoDir, 7);

    expect(archived).toContain("feature-branch");
    expect(skipped).not.toContain("feature-branch");

    const meta = await getStash(wtDir, "feature-branch");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("archived");
    expect(meta!.archived_at).toBeDefined();
    expect(meta!.archive_path).toBeDefined();

    // Archive file should exist
    expect(await exists(meta!.archive_path!)).toBe(true);

    // Git ref should be deleted
    const refResult = await execa(
      "git",
      ["show-ref", "--verify", `refs/wt/stashes/feature-branch`],
      { cwd: repoDir, reject: false }
    );
    expect(refResult.exitCode).not.toBe(0);
  });

  it("does NOT archive a stash when the branch still exists on remote", async () => {
    const containerDir = await mktemp();
    const { remoteDir: _remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);

    // Age the stash but do NOT delete the remote branch
    await ageStash(wtDir, "feature-branch", 8);

    const { archived, skipped } = await archiveScan(wtDir, repoDir, 7);

    expect(archived).not.toContain("feature-branch");
    expect(skipped).toContain("feature-branch");

    const meta = await getStash(wtDir, "feature-branch");
    expect(meta!.status).toBe("active");
  });

  it("does NOT archive a stash that was used recently (last_used_at < archiveAfterDays)", async () => {
    const containerDir = await mktemp();
    const { remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);

    // Delete remote branch but keep last_used_at recent (2 days ago)
    await deleteRemoteBranch(remoteDir, repoDir, "feature-branch");
    await ageStash(wtDir, "feature-branch", 2);

    const { archived, skipped } = await archiveScan(wtDir, repoDir, 7);

    expect(archived).not.toContain("feature-branch");
    expect(skipped).toContain("feature-branch");

    const meta = await getStash(wtDir, "feature-branch");
    expect(meta!.status).toBe("active");
  });

  it("uses last_used_at for age, not created_at", async () => {
    const containerDir = await mktemp();
    const { remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);
    await deleteRemoteBranch(remoteDir, repoDir, "feature-branch");

    // Manually set created_at to 30 days ago but last_used_at to 2 days ago
    const meta = await getStash(wtDir, "feature-branch");
    const { stringify } = await import("smol-toml");
    const { encodeBranch } = await import("../../src/core/branch-encode.js");
    const encoded = encodeBranch("feature-branch");
    const filePath = path.join(wtDir, "stashes", `${encoded}.toml`);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(filePath, stringify({
      branch: meta!.branch,
      commit: meta!.commit,
      stash_ref: meta!.stash_ref,
      created_at: thirtyDaysAgo,
      last_used_at: twoDaysAgo,
      status: "active",
    }), "utf8");

    const { archived } = await archiveScan(wtDir, repoDir, 7);

    // Should NOT be archived — last_used_at is only 2 days ago
    expect(archived).not.toContain("feature-branch");
    const metaAfter = await getStash(wtDir, "feature-branch");
    expect(metaAfter!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// dropStash: active and archived
// ---------------------------------------------------------------------------

describe("dropStash", () => {
  it("deletes ref and metadata for an active stash", async () => {
    const containerDir = await mktemp();
    const { remoteDir: _r, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);

    expect(await getStash(wtDir, "feature-branch")).not.toBeNull();

    await dropStash(wtDir, repoDir, "feature-branch");

    expect(await getStash(wtDir, "feature-branch")).toBeNull();

    // Git ref should be deleted
    const refResult = await execa(
      "git",
      ["show-ref", "--verify", "refs/wt/stashes/feature-branch"],
      { cwd: repoDir, reject: false }
    );
    expect(refResult.exitCode).not.toBe(0);
  });

  it("deletes archive file and metadata for an archived stash", async () => {
    const containerDir = await mktemp();
    const { remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);
    await deleteRemoteBranch(remoteDir, repoDir, "feature-branch");
    await ageStash(wtDir, "feature-branch", 8);

    // Archive the stash
    await archiveStash(wtDir, repoDir, "feature-branch");

    const meta = await getStash(wtDir, "feature-branch");
    expect(meta!.status).toBe("archived");
    const archivePath = meta!.archive_path!;
    expect(await exists(archivePath)).toBe(true);

    // Drop
    await dropStash(wtDir, repoDir, "feature-branch");

    expect(await getStash(wtDir, "feature-branch")).toBeNull();
    expect(await exists(archivePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// archiveStash: zstd fallback
// ---------------------------------------------------------------------------

describe("archiveStash zstd fallback", () => {
  it("stores uncompressed .patch file when zstd is unavailable", async () => {
    const containerDir = await mktemp();
    const { remoteDir: _r, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);

    // Mock isZstdAvailable to return false
    vi.spyOn(
      await import("../../src/core/stash.js"),
      "isZstdAvailable"
    ).mockResolvedValueOnce(false);

    await archiveStash(wtDir, repoDir, "feature-branch");

    const meta = await getStash(wtDir, "feature-branch");
    expect(meta!.status).toBe("archived");
    expect(meta!.archive_path).toBeDefined();
    // Should be .patch (uncompressed), not .patch.zst
    expect(meta!.archive_path).toMatch(/\.patch$/);
    expect(await exists(meta!.archive_path!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkout triggers archive scan
// ---------------------------------------------------------------------------

describe("checkout triggers archive scan", () => {
  it("archives qualifying stash during checkout", async () => {
    const containerDir = await mktemp();
    const { remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);
    await deleteRemoteBranch(remoteDir, repoDir, "feature-branch");
    await ageStash(wtDir, "feature-branch", 8);

    // Trigger archive scan via checkout of another branch
    await execa("git", ["branch", "another-branch"], { cwd: repoDir });

    // The scan fires on every checkout, so just checking out any branch will trigger it
    const state = await readState(wtDir);
    // Find a vacant slot or pick any non-feature slot
    const anyBranch = Object.entries(state.slots).find(
      ([, s]) => s.branch !== "feature-branch"
    )?.[1]?.branch;

    if (anyBranch) {
      await runCheckout({ branch: anyBranch, cwd: containerDir });
    } else {
      await runCheckout({ branch: "another-branch", cwd: containerDir });
    }

    const meta = await getStash(wtDir, "feature-branch");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// fetch triggers archive scan
// ---------------------------------------------------------------------------

describe("fetch triggers archive scan", () => {
  it("archives qualifying stash during fetch", async () => {
    const containerDir = await mktemp();
    const { remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);
    await deleteRemoteBranch(remoteDir, repoDir, "feature-branch");
    await ageStash(wtDir, "feature-branch", 8);

    await runFetch({ cwd: containerDir });

    const meta = await getStash(wtDir, "feature-branch");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// clean command with archiveScan
// ---------------------------------------------------------------------------

describe("wt clean with archive scan", () => {
  it("lists and deletes archived stashes", async () => {
    const containerDir = await mktemp();
    const { remoteDir, wtDir, repoDir } = await setupRemoteContainer(containerDir);

    await createStashForFeatureBranch(containerDir, wtDir, repoDir);
    await deleteRemoteBranch(remoteDir, repoDir, "feature-branch");
    await ageStash(wtDir, "feature-branch", 8);

    // Archive it first so clean can find it
    await archiveStash(wtDir, repoDir, "feature-branch");

    // Capture output
    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      // autoConfirm selects all archived stashes for deletion
      await runClean({ cwd: containerDir, autoConfirm: true });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = lines.join("");
    expect(output).toContain("Deleted");

    // Stash should be gone
    expect(await getStash(wtDir, "feature-branch")).toBeNull();
  });

  it("prints no-op message when no archived stashes exist", async () => {
    const containerDir = await mktemp();
    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await createBareRemote(remoteDir);
    await runInit({ url: remoteDir, cwd: containerDir });

    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runClean({ cwd: containerDir });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(lines.join("")).toContain("No archived stashes");
  });
});

// ---------------------------------------------------------------------------
// isZstdAvailable
// ---------------------------------------------------------------------------

describe("isZstdAvailable", () => {
  it("returns a boolean without throwing", async () => {
    const result = await isZstdAvailable();
    expect(typeof result).toBe("boolean");
  });
});
