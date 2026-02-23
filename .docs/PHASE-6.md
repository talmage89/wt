# Phase 6: Stash Archival

**Goal**: Full stash lifecycle — active → archived → deleted — with zstd compression.

**Depends on**: Phase 5 (all CLI commands, stash infrastructure).

---

## 6.1 Archive Mechanism

### Purpose
Implement stash archival: when a branch is deleted on the remote AND the stash hasn't been used via `wt` in `archive_after_days` days, compress the stash as a patch file and free the git ref (VISION Section 5.3, 5.4).

### zstd Strategy

Two options:
1. **Shell out to `zstd` binary** — simpler, requires `zstd` installed on the system.
2. **Use a Node.js binding** — e.g., `@mixmark-io/zstd` or `fzstd` (pure JS).

**Chosen approach**: Shell out to the `zstd` binary via `execa`. It's the most reliable and matches the "git errors pass through" philosophy. If `zstd` is not installed, `wt` warns but still archives (just stores uncompressed `.patch` files as fallback).

### New git.ts functions

```ts
/**
 * Export a stash as a patch.
 * `git stash show -p --include-untracked <ref>`
 */
export async function stashShowPatch(
  repoDir: string,
  ref: string
): Promise<string>;
// Note: this already exists as `stashShow` from Phase 3.
// May need to verify --include-untracked works with `git stash show`.
// Alternative: `git diff <ref>^..<ref>` for the full diff.
```

### Core archive functions in `core/stash.ts`

```ts
/**
 * Archive a single stash: export as compressed patch, delete git ref.
 * 1. Export patch: `git stash show -p <stash_ref>` (or git diff)
 * 2. Compress: pipe through `zstd` → .wt/stashes/archive/<encoded>.patch.zst
 * 3. Delete git ref
 * 4. Update metadata TOML: status="archived", archived_at, archive_path
 */
export async function archiveStash(
  wtDir: string,
  repoDir: string,
  branch: string
): Promise<void>;

/**
 * Scan all active stashes and archive those that qualify.
 * Criteria: remote branch deleted AND last_used_at > archive_after_days ago.
 */
export async function archiveScan(
  wtDir: string,
  repoDir: string,
  archiveAfterDays: number
): Promise<{ archived: string[]; skipped: string[] }>;

/**
 * Check if zstd is available on the system.
 */
export async function isZstdAvailable(): Promise<boolean>;
```

---

## 6.2 `archiveStash` Implementation

```
async function archiveStash(wtDir, repoDir, branch):
  meta = await getStash(wtDir, branch)
  if (!meta || meta.status !== "active") return

  encoded = encodeBranch(branch)
  archiveDir = path.join(wtDir, "stashes", "archive")
  await mkdir(archiveDir, { recursive: true })

  // Export patch
  const patch = await git.stashShow(repoDir, meta.stash_ref)
  // Note: `git stash show -p` may not include untracked files.
  // Better approach: `git diff <parent>...<stash_ref>` + untracked tree diff.
  // For simplicity, use `git stash show -p --stat` and accept the limitation,
  // or use `git diff --binary <meta.commit> <meta.stash_ref>`.
  //
  // Actually, the stash commit created by `git stash create -u` has a specific
  // structure: it's a merge commit with the working tree changes.
  // `git diff <meta.commit>..<meta.stash_ref>` should capture everything.

  // Compress with zstd
  archivePath = path.join(archiveDir, `${encoded}.patch.zst`)

  if (await isZstdAvailable()):
    // Pipe patch through zstd
    await execa("zstd", ["-o", archivePath], { input: patch })
  else:
    // Fallback: store uncompressed
    archivePath = path.join(archiveDir, `${encoded}.patch`)
    await writeFile(archivePath, patch)
    console.error("Warning: zstd not found. Archived stash stored uncompressed.")

  // Delete git ref
  await git.deleteRef(repoDir, `refs/wt/stashes/${encoded}`)

  // Update metadata
  meta.status = "archived"
  meta.archived_at = new Date().toISOString()
  meta.archive_path = archivePath
  await writeStashMetadata(wtDir, branch, meta)
```

---

## 6.3 `archiveScan` Implementation

```
async function archiveScan(wtDir, repoDir, archiveAfterDays):
  const stashes = await listStashes(wtDir)
  const activeStashes = stashes.filter(s => s.status === "active")

  const archived: string[] = []
  const skipped: string[] = []

  for (const stash of activeStashes):
    // Check age: last_used_at must be older than archiveAfterDays
    const lastUsed = new Date(stash.last_used_at)
    const daysSinceUse = (Date.now() - lastUsed.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSinceUse < archiveAfterDays):
      skipped.push(stash.branch)
      continue

    // Check remote: branch must NOT exist on remote
    const exists = await git.remoteBranchExists(repoDir, stash.branch)
    if (exists):
      skipped.push(stash.branch)
      continue

    // Both conditions met — archive
    await archiveStash(wtDir, repoDir, stash.branch)
    archived.push(stash.branch)

  return { archived, skipped }
```

---

## 6.4 Integration Points

### Checkout flow (Phase 3, `commands/checkout.ts`)
Step 5 (archive scan) now calls the real `archiveScan`:

```ts
// Step 5: Archive scan
const config = await readConfig(paths.wtDir);
const { archived } = await archiveScan(paths.wtDir, paths.repoDir, config.archive_after_days);
if (archived.length > 0) {
  console.error(`Archived ${archived.length} stash(es): ${archived.join(", ")}`);
}
```

### Fetch command (Phase 5, `commands/fetch.ts`)
Now calls `archiveScan` after fetch.

### Clean command (Phase 5, `commands/clean.ts`)
Now calls `archiveScan` before listing archived stashes.

---

## 6.5 Stash Deletion (Full)

Update `dropStash` in `core/stash.ts` to handle both active and archived stashes:

```
async function dropStash(wtDir, repoDir, branch):
  meta = await getStash(wtDir, branch)
  if (!meta) return

  encoded = encodeBranch(branch)

  if (meta.status === "active"):
    // Delete git ref
    await git.deleteRef(repoDir, `refs/wt/stashes/${encoded}`)

  if (meta.status === "archived" && meta.archive_path):
    // Delete archive file
    await rm(meta.archive_path, { force: true })

  // Delete metadata TOML
  await rm(path.join(wtDir, "stashes", `${encoded}.toml`), { force: true })
```

---

## 6.6 Integration Tests

### `test/integration/archive.test.ts`

**Test: stash archived when branch deleted on remote and old enough**
1. Init container, checkout branch A, create dirty state, evict.
2. Delete branch A on the remote.
3. Manually set `last_used_at` to 8 days ago in the stash metadata.
4. Run `archiveScan(wtDir, repoDir, 7)`.
5. Verify: stash status is "archived".
6. Verify: `.patch.zst` (or `.patch`) file exists in archive dir.
7. Verify: git ref `refs/wt/stashes/<encoded>` is deleted.

**Test: stash NOT archived if branch still on remote**
1. Same as above but don't delete the remote branch.
2. Run `archiveScan`.
3. Verify: stash still "active".

**Test: stash NOT archived if recently used**
1. Same as above, delete remote branch, but `last_used_at` is 2 days ago.
2. Run `archiveScan`.
3. Verify: stash still "active".

**Test: stash NOT archived if last_used_at recently reset**
1. Stash created 30 days ago, but `last_used_at` is 2 days ago (user checked out the branch recently).
2. Run `archiveScan`.
3. Verify: stash still "active" (last_used_at governs, not created_at).

**Test: drop active stash deletes ref and metadata**
1. Create stash.
2. `dropStash`.
3. Verify: metadata file gone, git ref gone.

**Test: drop archived stash deletes archive file and metadata**
1. Create stash, archive it.
2. `dropStash`.
3. Verify: archive file gone, metadata file gone.

**Test: clean command lists and deletes archived stashes**
1. Create multiple stashes, archive some.
2. Mock stdin to select specific stashes for deletion.
3. Run `runClean()`.
4. Verify: selected stashes deleted, others remain.

**Test: zstd fallback when not available**
1. Mock `isZstdAvailable` to return false.
2. Archive a stash.
3. Verify: `.patch` file created (uncompressed), not `.patch.zst`.

---

## 6.7 Archive scan integration in checkout/fetch/clean

Verify that archive scan runs in these commands:

**Test: checkout triggers archive scan**
1. Set up archived stash conditions.
2. Run `runCheckout`.
3. Verify: stash was archived during checkout.

**Test: fetch triggers archive scan**
1. Set up archived stash conditions.
2. Run `runFetch`.
3. Verify: stash was archived.

---

## Phase 6 Completion Checklist

- [ ] `archiveStash` — export patch, compress, delete ref, update metadata
- [ ] `archiveScan` — scan active stashes, check remote + age, trigger archival
- [ ] `isZstdAvailable` — detect zstd binary
- [ ] zstd compression works (or graceful fallback to uncompressed)
- [ ] `dropStash` handles both active and archived stashes
- [ ] Archive scan integrated into checkout, fetch, clean commands
- [ ] `.wt/stashes/archive/` directory created as needed
- [ ] `last_used_at` governs archive age (not `created_at`)
- [ ] Integration tests: archive conditions (age + remote deletion)
- [ ] Integration tests: archive scan in checkout/fetch/clean
- [ ] Integration tests: drop active and archived stashes
- [ ] Integration tests: zstd fallback
