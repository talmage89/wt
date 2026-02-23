# Phase 8: Polish & Edge Cases

**Goal**: Production-ready. All edge cases handled, slot count changes work, error handling is thorough, end-to-end tests pass, and the tool is packaged for distribution.

**Depends on**: Phase 7 (TUI complete — all features exist).

---

## 8.1 Slot Count Changes

### Purpose
Handle dynamic changes to `slot_count` in `.wt/config.toml` (VISION Section 10.1).

### Detection

On every `wt` command, after reading config and state, compare `config.slot_count` with `Object.keys(state.slots).length`. If they differ, trigger slot adjustment.

### Interface (`core/slots.ts` additions)

```ts
/**
 * Adjust slot count to match the configured value.
 * - Increasing: create new vacant slots.
 * - Decreasing: evict excess slots (LRU order), error if pinned > new count.
 */
export async function adjustSlotCount(
  repoDir: string,
  containerDir: string,
  wtDir: string,
  state: State,
  config: Config
): Promise<State>;
```

### Increasing slots

```
1. newCount = config.slot_count - currentSlotCount
2. defaultCommit = await git.defaultBranch(repoDir) → resolve to commit hash
3. newNames = await createSlots(repoDir, containerDir, newCount, `origin/${defaultCommit}`, existingNames)
4. For each new slot: add to state with branch=null, lastUsedAt=now, pinned=false
5. Generate templates for new slots
6. Establish symlinks for new slots
7. Write state
```

### Decreasing slots

```
1. excessCount = currentSlotCount - config.slot_count
2. pinnedCount = slots where pinned === true
3. if (pinnedCount > config.slot_count):
     throw: "Cannot reduce slot count to <N>: <M> worktrees are pinned. Unpin worktrees first or choose a higher count."
4. Collect eviction candidates: non-pinned slots, sorted by last_used_at ascending
5. If we need to evict a slot that has a branch (not vacant):
   - Save stash if dirty
   - Remove the git worktree: `git worktree remove <path>`
6. If slot is vacant:
   - Just remove: `git worktree remove <path>`
7. Remove the slot directory
8. Remove from state.slots
9. Write state
```

### Integration point

Add to the reconciliation step in every command (or as a separate post-reconcile step):

```ts
// After reconcile, before command logic:
if (Object.keys(state.slots).length !== config.slot_count) {
  state = await adjustSlotCount(paths.repoDir, paths.container, paths.wtDir, state, config);
}
```

---

## 8.2 Error Handling Hardening

### All error scenarios from VISION Section 15

| Scenario | Implementation |
|---|---|
| All slots pinned, no vacant, checkout | Already handled in `selectSlotForCheckout` (Phase 2) |
| Slot count reduced below pinned count | Handled in `adjustSlotCount` (8.1 above) |
| `wt init` in non-empty, non-git directory | Validation in `commands/init.ts` (Phase 2) — verify fully covered |
| `wt` command outside managed container | Each command calls `findContainer()`; if null, print help or error |
| Direct `git checkout` detected | `reconcile.ts` handles this silently (Phase 3) |
| Shared symlink target is git-tracked | `establishSymlinks` skips with warning (Phase 4) |
| Stash restore conflicts | `restoreStash` warns and retains stash (Phase 3) |
| Git errors pass through | All `core/git.ts` functions use `stdio: ['ignore','pipe','inherit']` |

### Additional edge cases to handle

**Concurrent `wt` operations:**
- Two `wt checkout` commands running simultaneously could corrupt state.
- Mitigation: Use a lock file (`.wt/lock`) with advisory locking via `fs.open` with `O_EXCL`.
- If lock is held: "Another wt operation is in progress. If this is stale, remove .wt/lock."

```ts
// core/lock.ts
export async function acquireLock(wtDir: string): Promise<() => Promise<void>>;
```

**Corrupted state.toml:**
- If TOML parsing fails: warn and regenerate state from git reality.
- Run reconcile from scratch (scan all directories, detect branches).

**Missing .wt/repo/:**
- If `.wt/` exists but `.wt/repo/` is missing: fatal error.
- "Container is corrupted: .wt/repo/ is missing."

**Orphaned worktree directories:**
- A slot directory exists but isn't registered as a git worktree.
- Reconcile should detect this via `git worktree list` and either re-register or warn.

**Worktree registered in git but directory missing:**
- `git worktree list` shows a worktree but the directory was deleted.
- Reconcile should `git worktree prune` to clean up, then remove from state.

---

## 8.3 Reconciliation Hardening

### Enhanced `reconcile.ts`

```
1. Run `git worktree list --porcelain` in .wt/repo/
   → Get list of all registered worktrees with their paths and branches.

2. List all subdirectories of container that are NOT .wt
   → These are potential slot directories.

3. Cross-reference:
   a. Slot dir exists AND in git worktree list → normal, update branch in state
   b. Slot dir exists but NOT in git worktree list → orphaned directory
      - Try: `git worktree add` to re-register? No — might conflict.
      - Better: warn and remove from state. User can re-init if needed.
   c. In git worktree list but dir missing → stale worktree registration
      - Run `git worktree prune` to clean up
      - Remove from state

4. Run `git worktree prune` to clean up any stale worktree registrations.

5. For each valid slot:
   - Detect actual branch via `git symbolic-ref --short HEAD` in the slot.
   - Compare with state. Update if different (silent reconcile).
   - If HEAD is detached, mark slot as vacant.
```

---

## 8.4 Performance Optimizations

### Parallel git status checks

When listing worktrees (`wt list`) or building the TUI data, git status needs to be checked for each slot. Run these in parallel:

```ts
const statusResults = await Promise.all(
  slotNames.map(async (name) => ({
    name,
    dirty: (await git.status(path.join(containerDir, name))).length > 0,
  }))
);
```

### Lazy branch search in TUI

Don't load all remote branches upfront. Fetch them on-demand when the user opens search (`/`).

### Cache remote branch existence checks

During archive scan, cache `git ls-remote` results to avoid redundant network calls:

```ts
const remoteHeads = await git.listRemoteHeads(repoDir); // single call
for (const stash of activeStashes) {
  if (!remoteHeads.has(stash.branch)) { /* archive candidate */ }
}
```

---

## 8.5 End-to-End Tests

Full workflow tests that simulate real user scenarios.

### `test/e2e/workflow.test.ts`

**Test: complete init → checkout → eviction → restore cycle**
1. Create a test repo with branches A, B, C.
2. `wt init` → verify structure.
3. `wt checkout A` → verify slot assignment.
4. Create dirty state in A.
5. `wt checkout B` → verify A evicted with stash, B checked out.
6. `wt checkout C` → verify B evicted (or another slot), C checked out.
7. `wt checkout A` → verify A restored with dirty state.

**Test: pin prevents eviction**
1. Init with 2 slots. Checkout A and B.
2. Pin A.
3. Checkout C → B is evicted (not A).
4. Verify A still has its branch.

**Test: sync propagates shared files**
1. Init with shared config for `.claude/`.
2. Create `.wt/shared/.claude/settings.json`.
3. Run `wt sync`.
4. Verify all slots have symlinks.
5. Edit through one symlink → verify all slots see the change.

**Test: template regeneration on checkout**
1. Init with template config.
2. Checkout branch A in slot X.
3. Verify template file in slot X has `{{BRANCH_NAME}}` expanded to `A`.
4. Checkout branch B (evicts X).
5. Checkout branch C in slot X.
6. Verify template file in slot X now has `C`.

**Test: shell integration**
1. Source the shell init output.
2. Run `wt checkout A`.
3. Verify shell cwd changed to the correct slot.
(This test is tricky — may need to test by verifying nav file content rather than actual shell cd.)

**Test: reconcile after direct git checkout**
1. Init, checkout A in slot X.
2. `cd` into slot X, run `git checkout B` directly.
3. Run `wt list` (triggers reconcile).
4. Verify: state shows slot X has branch B.

**Test: slot count increase**
1. Init with slot_count=3.
2. Edit config to slot_count=5.
3. Run `wt list` (triggers adjustment).
4. Verify: 5 slots exist.

**Test: slot count decrease**
1. Init with slot_count=5, checkout branches in 3 slots.
2. Edit config to slot_count=3.
3. Run `wt list`.
4. Verify: 2 vacant slots removed, 3 remain.

**Test: slot count decrease blocked by pins**
1. Init with slot_count=5, pin 4 slots.
2. Edit config to slot_count=3.
3. Run `wt list`.
4. Verify: error about pinned count exceeding new slot count.

---

## 8.6 CLI Help & Documentation

### `--help` text

Each command should have clear, concise help text. Yargs generates this from the command descriptions and option configs. Verify:

- `wt --help` shows all commands with descriptions.
- `wt checkout --help` shows `--no-restore` flag.
- `wt stash --help` shows subcommands.
- `wt shell-init --help` shows shell choices.

### Version

Add `--version` flag:
```ts
.version(require("../package.json").version)
```

---

## 8.7 Packaging & Distribution

### package.json final

```jsonc
{
  "name": "wt",
  "version": "0.1.0",
  "description": "Opinionated CLI + TUI for managing git worktrees via reusable slots",
  "type": "module",
  "bin": { "wt": "./bin/wt.mjs" },
  "main": "./dist/cli.js",
  "files": ["bin/", "dist/"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/ test/",
    "prepublishOnly": "pnpm build"
  }
}
```

### Verify

- `pnpm build` produces working `dist/`.
- `node bin/wt.mjs --help` works.
- `node bin/wt.mjs --version` works.
- `npx . init` works from a test repo.
- `npx . shell-init bash` outputs valid shell code.

### Global install test

```bash
pnpm pack
npm install -g ./wt-0.1.0.tgz
wt --help
```

---

## 8.8 Cleanup

- Remove any `console.log` debugging statements.
- Ensure all `TODO` comments are resolved.
- Verify all test fixtures are cleaned up after tests.
- Run full test suite: `pnpm test`.
- Run linter: `pnpm lint`.

---

## Phase 8 Completion Checklist

- [ ] `adjustSlotCount` — increase and decrease handling
- [ ] Slot count decrease blocked by pinned count
- [ ] Lock file for concurrent operations
- [ ] Corrupted state recovery
- [ ] Missing `.wt/repo/` detection
- [ ] Orphaned worktree handling
- [ ] `git worktree prune` in reconciliation
- [ ] Parallel git status checks
- [ ] End-to-end tests: full workflow cycle
- [ ] End-to-end tests: pin prevents eviction
- [ ] End-to-end tests: sync + templates
- [ ] End-to-end tests: shell integration
- [ ] End-to-end tests: reconciliation
- [ ] End-to-end tests: slot count changes
- [ ] `--help` text for all commands verified
- [ ] `--version` flag works
- [ ] `package.json` `files` field correct
- [ ] `pnpm build` → `node bin/wt.mjs` works
- [ ] Global install works
- [ ] No stray console.log or TODO comments
- [ ] Full test suite passes
- [ ] Linter passes
