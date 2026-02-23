# Phase 5: Remaining CLI Commands

**Goal**: All CLI commands from VISION Section 9 are implemented and wired into the CLI entry point.

**Depends on**: Phase 4 (sync, full symlinks/templates).

---

## 5.1 `commands/fetch.ts`

### Purpose
Implement `wt fetch` — centralized fetch + archive scan trigger (VISION Sections 9, 12).

### Interface

```ts
export async function runFetch(): Promise<void>;
```

### Flow

```
1. Find container
   paths = findContainer(cwd)
   if (!paths) → error

2. Reconcile
   state = readState(paths.wtDir)
   state = reconcile(paths.wtDir, paths.container, state)

3. Fetch
   git.fetch(paths.repoDir)
   Print: "Fetched latest from remote."

4. Archive scan (Phase 6 provides full implementation)
   // Stub in Phase 5: call archiveScan if implemented, else skip.
   // The function signature exists from Phase 3's core/stash.ts but
   // the zstd compression piece comes in Phase 6.
```

### CLI wiring

```ts
.command(
  "fetch",
  "Run a centralized git fetch",
  () => {},
  async () => { await runFetch(); }
)
```

---

## 5.2 `commands/stash.ts`

### Purpose
Implement `wt stash list|apply|drop|show` (VISION Sections 5.2.1, 9).

### Interface

```ts
export async function runStashList(): Promise<void>;
export async function runStashApply(branch?: string): Promise<void>;
export async function runStashDrop(branch?: string): Promise<void>;
export async function runStashShow(branch?: string): Promise<void>;
```

### `wt stash list`

```
1. Find container, read state
2. stashes = listStashes(paths.wtDir)
3. Print table:

   Branch                 Age        Status    Base Commit
   ─────────────────────  ─────────  ────────  ───────────
   feature/my-branch      2h ago     active    abc1234
   fix/login-bug          3d ago     active    def5678
   old/archived-branch    15d ago    archived  789abcd

4. If no stashes: "No saved stashes."
```

### `wt stash apply [branch]`

```
1. Find container, reconcile
2. If branch not specified: detect current branch from cwd's worktree slot
   currentSlot = currentSlotName(cwd, paths)
   if (!currentSlot) → error: "Not inside a worktree slot."
   branch = state.slots[currentSlot].branch
   if (!branch) → error: "Current slot is in detached HEAD state."
3. stash = getStash(paths.wtDir, branch)
   if (!stash) → error: "No stash found for branch '<branch>'."
   if (stash.status === "archived") → error: "Stash for '<branch>' is archived. Use 'wt clean' to manage archived stashes."
4. Find worktree for this branch
   slot = findSlotForBranch(state, branch)
   if (!slot) → error: "Branch '<branch>' is not checked out in any slot. Run 'wt checkout <branch>' first."
5. worktreeDir = path.join(paths.container, slot)
6. result = restoreStash(paths.wtDir, paths.repoDir, branch, worktreeDir)
7. Switch on result:
   "restored" → "Stash applied and cleaned up for '<branch>'."
   "conflict" → "Stash applied with conflicts. Resolve manually, then run 'wt stash drop <branch>'."
   "none"     → "No stash found for '<branch>'."  (shouldn't happen, already checked)
```

### `wt stash drop [branch]`

```
1. Find container
2. Resolve branch (same as apply — default to current)
3. stash = getStash(paths.wtDir, branch)
   if (!stash) → error: "No stash found for branch '<branch>'."
4. Confirmation prompt:
   "Drop stash for '<branch>'? This cannot be undone. [y/N] "
   If not confirmed → abort.
5. dropStash(paths.wtDir, paths.repoDir, branch)
6. "Stash dropped for '<branch>'."
```

### `wt stash show [branch]`

```
1. Find container
2. Resolve branch (same as apply — default to current)
3. stash = getStash(paths.wtDir, branch)
   if (!stash) → error: "No stash found for branch '<branch>'."
   if (stash.status === "archived") → error: "Stash is archived. Cannot show diff from archived stash."
4. diff = showStash(paths.repoDir, stash.stash_ref)
5. Print diff to stdout (pipe through pager if tty).
```

### CLI wiring

```ts
.command(
  "stash <action> [branch]",
  "Manage stashes",
  (yargs) => yargs
    .positional("action", {
      type: "string",
      choices: ["list", "apply", "drop", "show"],
      demandOption: true,
    })
    .positional("branch", {
      type: "string",
      describe: "Branch name (defaults to current branch)",
    }),
  async (argv) => {
    switch (argv.action) {
      case "list": return runStashList();
      case "apply": return runStashApply(argv.branch as string | undefined);
      case "drop": return runStashDrop(argv.branch as string | undefined);
      case "show": return runStashShow(argv.branch as string | undefined);
    }
  }
)
```

---

## 5.3 `commands/list.ts`

### Purpose
Implement `wt list` (alias `wt ls`) — display all worktree slots (VISION Section 9).

### Interface

```ts
export async function runList(): Promise<void>;
```

### Output format

```
Slot                   Branch               Status  Pinned  Last Used
─────────────────────  ───────────────────  ──────  ──────  ─────────
crimson-maple-river    feature/my-branch    dirty   pinned  2m ago
gentle-autumn-spark    main                 clean           5h ago
bright-coral-dawn      fix/login-bug        clean           1d ago
silver-frost-meadow    (vacant)                             3d ago
hollow-pine-creek      (vacant)                             3d ago
```

### Flow

```
1. Find container, read state + config
2. Reconcile
3. For each slot in state.slots:
   - slotName
   - branch (or "(vacant)" if null)
   - status: run git.status(worktreeDir) → "dirty" or "clean"
   - pinned: "pinned" or ""
   - lastUsed: relative time from last_used_at
4. Print formatted table
```

### Relative time formatting

Utility function (can live in a small `core/format.ts` or inline):

```ts
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

### CLI wiring

```ts
.command(
  "list",
  "List worktree slots",
  () => {},
  async () => { await runList(); }
)
.alias("ls", "list")
```

---

## 5.4 `commands/pin.ts`

### Purpose
Implement `wt pin [slot]` and `wt unpin [slot]` (VISION Sections 9, 11).

### Interface

```ts
export async function runPin(slotName?: string): Promise<void>;
export async function runUnpin(slotName?: string): Promise<void>;
```

### Flow (pin)

```
1. Find container, read state, reconcile
2. Resolve slot:
   - If slotName provided: use it directly
   - If not: detect current slot from cwd
     currentSlot = currentSlotName(cwd, paths)
     if (!currentSlot) → error: "Not inside a worktree slot. Specify a slot name."
3. Validate: slot exists in state
4. If already pinned → "Slot '<slot>' is already pinned."
5. state.slots[slot].pinned = true
6. writeState
7. "Pinned '<slot>' (branch: <branch>). It will not be evicted."
```

### Flow (unpin)

Same as pin but sets `pinned = false`.

```
7. "Unpinned '<slot>' (branch: <branch>). It can now be evicted via LRU."
```

### CLI wiring

```ts
.command(
  "pin [slot]",
  "Pin a worktree slot to prevent LRU eviction",
  (yargs) => yargs.positional("slot", { type: "string", describe: "Slot name (defaults to current)" }),
  async (argv) => { await runPin(argv.slot as string | undefined); }
)
.command(
  "unpin [slot]",
  "Unpin a worktree slot",
  (yargs) => yargs.positional("slot", { type: "string", describe: "Slot name (defaults to current)" }),
  async (argv) => { await runUnpin(argv.slot as string | undefined); }
)
```

---

## 5.5 `commands/clean.ts`

### Purpose
Implement `wt clean` — interactive review and deletion of archived stashes (VISION Sections 5.5, 9). Also triggers an archive scan.

### Interface

```ts
export async function runClean(): Promise<void>;
```

### Flow

```
1. Find container, reconcile
2. Trigger archive scan:
   archiveScan(paths.wtDir, paths.repoDir)
   (Full implementation in Phase 6. Phase 5 stub: scan but don't compress.)
3. List archived stashes:
   stashes = listStashes(paths.wtDir).filter(s => s.status === "archived")
4. If no archived stashes:
   "No archived stashes to clean."
   return
5. Interactive selection:
   Display each archived stash with:
   - Branch name
   - Age (since created_at)
   - Archive file size

   Use a simple stdin-based multi-select:
   "Select stashes to delete (comma-separated numbers, or 'all', or 'none'):"

   [1] feature/old-branch  (15d ago, 2.3 KB)
   [2] fix/abandoned-pr    (30d ago, 1.1 KB)
   [3] experiment/test      (45d ago, 5.7 KB)

   > 1,3

6. Confirm: "Delete 2 stashes? [y/N] "
7. For each selected: dropStash(paths.wtDir, paths.repoDir, stash.branch)
8. "Deleted 2 archived stashes."
```

### Note on interactivity
For Phase 5, use simple `process.stdin` / `readline` for the interactive prompt. The TUI (Phase 7) provides a richer interface for this.

### CLI wiring

```ts
.command(
  "clean",
  "Review and delete archived stashes",
  () => {},
  async () => { await runClean(); }
)
```

---

## 5.6 Integration Tests

### `test/integration/pin.test.ts`

**Test: pin current worktree**
1. Init container, checkout branch A.
2. From slot A's directory, run `runPin()`.
3. Verify: state shows slot pinned.

**Test: unpin a worktree**
1. Pin a slot, then unpin.
2. Verify: state shows slot unpinned.

**Test: pinned slot not evicted**
1. Init with 2 slots. Fill both, pin slot A.
2. Checkout branch C → should evict slot B (not A).
3. Verify: A still has its branch, B was evicted.

**Test: pin non-existent slot → error**
1. Run `runPin("nonexistent")`.
2. Verify: error thrown.

### `test/integration/stash-commands.test.ts`

**Test: stash list shows stashes**
1. Init, create stash via eviction.
2. Run `runStashList()`.
3. Verify: output includes the stashed branch.

**Test: stash apply restores state**
1. Init, create dirty state, evict, checkout target branch.
2. Run `runStashApply(branch)`.
3. Verify: dirty state restored.

**Test: stash drop removes stash**
1. Create stash.
2. Run `runStashDrop(branch)` (mock confirmation to "y").
3. Verify: stash metadata gone, ref deleted.

**Test: stash show outputs diff**
1. Create stash.
2. Run `runStashShow(branch)`.
3. Verify: output contains diff content.

### `test/integration/list.test.ts`

**Test: list shows all slots**
1. Init with 3 slots, checkout 2 branches.
2. Run `runList()`.
3. Verify: output includes all 3 slots, correct branches, vacant markers.

### `test/integration/fetch.test.ts`

**Test: fetch updates remote tracking branches**
1. Init from URL, add commits to the "remote".
2. Run `runFetch()`.
3. Verify: `git log origin/main` shows the new commits.

---

## Phase 5 Completion Checklist

- [ ] `commands/fetch.ts` — centralized fetch
- [ ] `commands/stash.ts` — list, apply, drop, show subcommands
- [ ] `commands/list.ts` — formatted slot listing
- [ ] `commands/pin.ts` — pin and unpin
- [ ] `commands/clean.ts` — interactive archived stash cleanup
- [ ] All commands wired into `src/cli.ts`
- [ ] `wt ls` alias works
- [ ] `wt co` alias works (already from Phase 3)
- [ ] Relative time formatting works
- [ ] Stash commands default to current branch when no argument
- [ ] Integration tests for all new commands
- [ ] Complete CLI surface: every command from VISION Section 9 has an implementation (even if archive scan is stubbed)
