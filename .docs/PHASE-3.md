# Phase 3: Checkout & Stash Lifecycle

**Goal**: `wt checkout <branch>` works end-to-end with stash save/restore, slot eviction, reconciliation, and shell navigation.

**Depends on**: Phase 2 (init, container, slots, CLI entry point).

---

## 3.1 `core/stash.ts`

### Purpose
Save, restore, list, drop, and show stashes (VISION Section 5).

### Types

```ts
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
```

### Interface

```ts
import { encodeBranch } from "./branch-encode.js";

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
): Promise<boolean>;

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
): Promise<"restored" | "conflict" | "none">;

/**
 * List all stash metadata files.
 */
export async function listStashes(wtDir: string): Promise<StashMetadata[]>;

/**
 * Read stash metadata for a specific branch.
 */
export async function getStash(
  wtDir: string,
  branch: string
): Promise<StashMetadata | null>;

/**
 * Delete a stash (ref + metadata + archive file if present).
 */
export async function dropStash(
  wtDir: string,
  repoDir: string,
  branch: string
): Promise<void>;

/**
 * Show stash diff contents.
 */
export async function showStash(
  repoDir: string,
  stashRef: string
): Promise<string>;

/**
 * Update `last_used_at` for a stash (called when branch is checked out via wt).
 */
export async function touchStash(
  wtDir: string,
  branch: string
): Promise<void>;
```

### `saveStash` implementation detail

```
1. const hash = await git.stashCreate(worktreeDir)
2. if (!hash) return false  // clean worktree
3. const encoded = encodeBranch(branch)
4. await git.updateRef(repoDir, `refs/wt/stashes/${encoded}`, hash)
5. const commit = (await git.currentCommit(worktreeDir))  // HEAD hash
6. Write metadata TOML to `${wtDir}/stashes/${encoded}.toml`
7. return true
```

### `restoreStash` implementation detail

```
1. const meta = await getStash(wtDir, branch)
2. if (!meta || meta.status === "archived") return "none"
3. const result = await git.stashApply(worktreeDir, meta.stash_ref)
4. if (result.success && !result.conflicted):
     await git.deleteRef(repoDir, `refs/wt/stashes/${encodeBranch(branch)}`)
     delete metadata file
     return "restored"
5. if (result.conflicted):
     warn: "Stash for <branch> produced conflicts. Resolve manually."
     warn: "Run 'wt stash drop <branch>' after resolution, or 'wt stash show <branch>' to inspect."
     return "conflict"
```

### Metadata TOML format

File: `.wt/stashes/<encoded-branch>.toml`

```toml
branch = "feature/my-branch"
commit = "abc1234def5678..."
stash_ref = "fedcba9876543..."
created_at = 2026-02-22T10:30:00Z
last_used_at = 2026-02-22T10:30:00Z
status = "active"
```

---

## 3.2 `core/reconcile.ts`

### Purpose
Scan all worktree slots and update internal state to match git reality (VISION Section 3.2).

### Interface

```ts
import { State } from "./state.js";
import { ContainerPaths } from "./container.js";

/**
 * Reconcile internal state with actual git state.
 * For each slot directory in the container:
 *   - Detect current branch (or detached HEAD)
 *   - Update state.slots[name].branch accordingly
 *   - Preserve pinned status and LRU timestamps
 * Handles: direct `git checkout` by user, deleted worktrees, etc.
 * Returns the updated state (also writes it).
 */
export async function reconcile(
  wtDir: string,
  containerDir: string,
  state: State
): Promise<State>;
```

### Reconciliation logic

```
1. List all directories in containerDir that are NOT `.wt`
2. For each directory name:
   a. If not in state.slots → add it (newly discovered slot, e.g., created outside wt)
   b. Detect actual branch: git.currentBranch(slotPath)
   c. If state says branch=X but git says branch=Y → update state to Y (silent reconcile)
   d. If state says branch=X but git says detached → mark slot as vacant
   e. If state says vacant but git says branch=Y → update state to Y
3. For each slot in state.slots:
   a. If the slot directory no longer exists → remove from state
4. Write updated state
5. Return updated state
```

### Important: no warnings, no errors
Reconciliation is silent. It adapts state to reality without user-facing output (VISION Section 3.2).

---

## 3.3 `commands/checkout.ts`

### Purpose
Implement `wt checkout <branch>` — the primary user-facing operation (VISION Section 3.1).

### Interface

```ts
export interface CheckoutOptions {
  branch: string;
  noRestore?: boolean;  // --no-restore flag
}

/**
 * Execute the full checkout flow.
 * Returns the path to the target worktree (for nav file).
 */
export async function runCheckout(options: CheckoutOptions): Promise<string>;
```

### Full checkout flow

This is the most complex command. The steps map directly to VISION Section 3.1:

```
1. FIND CONTAINER
   paths = findContainer(cwd)
   if (!paths) → error: "Not inside a wt-managed container."

2. READ STATE + CONFIG
   state = readState(paths.wtDir)
   config = readConfig(paths.wtDir)

3. RECONCILE
   state = reconcile(paths.wtDir, paths.container, state)

4. FETCH
   git.fetch(paths.repoDir)
   (Centralized fetch — all worktrees share the object store.)

5. ARCHIVE SCAN (basic — full implementation in Phase 6)
   // For now, skip or do a lightweight version.
   // Full archive scan depends on zstd compression (Phase 6).

6. BRANCH ALREADY IN A SLOT?
   existingSlot = findSlotForBranch(state, options.branch)
   if (existingSlot):
     // Just navigate to it
     touchStash(paths.wtDir, options.branch)  // update last_used_at if stash exists
     markSlotUsed(state, existingSlot, options.branch)
     writeState(paths.wtDir, state)
     writeNavFile(path.join(paths.container, existingSlot))
     return

7. SELECT A SLOT
   targetSlot = selectSlotForCheckout(state)

8. EVICT (if slot is not vacant)
   if (!isVacant(state.slots[targetSlot])):
     evictedBranch = state.slots[targetSlot].branch
     worktreeDir = path.join(paths.container, targetSlot)

     // Save stash if dirty
     await saveStash(paths.wtDir, paths.repoDir, evictedBranch, worktreeDir)

     // Detach HEAD
     await git.checkoutDetach(worktreeDir)
     markSlotVacant(state, targetSlot)

9. CHECKOUT BRANCH
   worktreeDir = path.join(paths.container, targetSlot)

   // Try checkout. If branch doesn't exist locally, try creating from origin/<branch>.
   try:
     await git.checkout(worktreeDir, options.branch)
   catch:
     // Branch doesn't exist locally — try to create tracking branch
     await git.checkout(worktreeDir, `-b ${options.branch} origin/${options.branch}`)
     // If this also fails, the git error passes through to the user.

10. RESTORE STASH
    if (!options.noRestore):
      result = await restoreStash(paths.wtDir, paths.repoDir, options.branch, worktreeDir)
      if (result === "conflict"):
        // Warning already printed by restoreStash
      if (result === "restored"):
        // Success, stash cleaned up

11. REGENERATE TEMPLATES
    await generateTemplates(paths.wtDir, worktreeDir, targetSlot, options.branch, config.templates)

12. RECONCILE SYMLINKS
    await establishSymlinks(paths.wtDir, worktreeDir, config.shared.directories, options.branch)
    // Basic version in Phase 3; full sync in Phase 4.

13. UPDATE STATE
    markSlotUsed(state, targetSlot, options.branch)
    // Update branch_history
    state.branch_history = state.branch_history.filter(e => e.branch !== options.branch)
    state.branch_history.unshift({ branch: options.branch, last_checkout_at: new Date().toISOString() })
    await writeState(paths.wtDir, state)

14. POST-CHECKOUT HOOK
    hookPath = path.join(paths.wtDir, "hooks", "post-checkout")
    if (await fs.access(hookPath).then(() => true).catch(() => false)):
      // Hook execution happens in the shell function, not here.
      // The binary just writes the nav file; the shell handles the hook.

15. NAVIGATE
    await writeNavFile(worktreeDir)
```

### Branch creation logic (step 9 detail)

When `git checkout <branch>` fails because the branch doesn't exist locally:
1. Check if `origin/<branch>` exists: `git.remoteBranchExists(repoDir, branch)`.
2. If yes: `git checkout -b <branch> --track origin/<branch>`.
3. If no: error — let git's error pass through ("pathspec did not match...").

### CLI wiring

In `src/cli.ts`, replace the checkout stub:

```ts
.command(
  "checkout <branch>",
  "Check out a branch",
  (yargs) => yargs
    .positional("branch", { type: "string", demandOption: true })
    .option("no-restore", { type: "boolean", default: false, describe: "Skip automatic stash restoration" }),
  async (argv) => {
    const targetDir = await runCheckout({
      branch: argv.branch as string,
      noRestore: argv.noRestore,
    });
  }
)
.alias("co", "checkout")
```

---

## 3.4 Integration Tests

### Test helpers (`test/integration/helpers.ts`)

```ts
import { execa } from "execa";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Create a temporary directory for a test.
 */
export async function createTempDir(): Promise<string>;

/**
 * Create a git repo with an initial commit and a remote.
 * Returns the path to the repo.
 */
export async function createTestRepo(dir: string): Promise<string>;

/**
 * Initialize a wt container in a test repo.
 * Returns ContainerPaths.
 */
export async function initTestContainer(repoDir: string): Promise<ContainerPaths>;

/**
 * Create a branch with a commit in a test repo.
 */
export async function createBranch(repoDir: string, branch: string, file: string, content: string): Promise<void>;

/**
 * Clean up a temp directory.
 */
export async function cleanup(dir: string): Promise<void>;
```

### `test/integration/checkout.test.ts`

**Test: checkout a branch that exists on remote**
1. Set up: init container, create a remote branch.
2. Run `runCheckout({ branch: "feature/test" })`.
3. Verify: one slot has `feature/test` checked out, state updated, nav file written.

**Test: checkout a branch already in a slot**
1. Set up: init container, checkout branch A into a slot.
2. Run `runCheckout({ branch: "A" })` again.
3. Verify: same slot is used, nav file points to it, no eviction occurred.

**Test: checkout triggers LRU eviction**
1. Set up: init with 2 slots. Fill both with branches A and B.
2. Run `runCheckout({ branch: "C" })`.
3. Verify: the older slot was evicted, its stash saved if dirty, branch C now in that slot.

**Test: eviction saves dirty state**
1. Set up: init, checkout branch A, create uncommitted changes.
2. Checkout branch B (evicts A).
3. Verify: stash metadata exists for A, ref exists.
4. Checkout branch A again.
5. Verify: dirty state restored, stash cleaned up.

**Test: --no-restore skips stash restoration**
1. Set up: init, checkout A, dirty it, checkout B (evicts A with stash).
2. Checkout A with `--no-restore`.
3. Verify: stash still exists (not applied), worktree is clean.

**Test: checkout with all slots pinned**
1. Set up: init with 2 slots, fill both, pin both.
2. Run `runCheckout({ branch: "C" })`.
3. Verify: throws error about all slots pinned.

**Test: checkout with pinned slots but vacant slot available**
1. Set up: init with 3 slots, fill 2 and pin them, leave 1 vacant.
2. Run `runCheckout({ branch: "C" })`.
3. Verify: vacant slot is used, no error.

**Test: stash restore with conflict**
1. Set up: init, checkout A, dirty it, checkout B (stash A).
2. On branch B, make a conflicting change to the same file on branch A (rebase/amend A).
3. Checkout A again.
4. Verify: conflict warning emitted, stash retained.

### `test/integration/reconcile.test.ts`

**Test: direct git checkout detected**
1. Set up: init container, slot X has branch A.
2. Directly run `git checkout B` inside slot X (bypassing wt).
3. Run reconcile.
4. Verify: state now shows slot X has branch B.

**Test: slot removed externally**
1. Set up: init container with 3 slots.
2. Delete one slot directory.
3. Run reconcile.
4. Verify: state no longer includes the deleted slot.

**Test: new slot directory discovered**
1. Set up: init container.
2. Manually run `git worktree add` to create a new directory.
3. Run reconcile.
4. Verify: state includes the new directory.

---

## Phase 3 Completion Checklist

- [ ] `core/stash.ts` — save, restore, list, get, drop, show, touch
- [ ] `core/reconcile.ts` — full reconciliation logic
- [ ] `commands/checkout.ts` — full 15-step checkout flow
- [ ] CLI wiring — `wt checkout <branch>` and `wt co <branch>` work
- [ ] `--no-restore` flag works
- [ ] Integration tests: all checkout scenarios passing
- [ ] Integration tests: reconciliation scenarios passing
- [ ] Stash metadata TOML files created correctly
- [ ] Git refs anchored at `refs/wt/stashes/*`
- [ ] Nav file written for shell integration
- [ ] End-to-end: `wt init` → `wt checkout feature` → verify slot assignment
