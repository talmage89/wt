## BUG-018: `wt stash drop` with stdin=/dev/null still crashes (exit 13) — `promptConfirm` fix incomplete

**Status**: open
**Found**: 2026-02-25T05:57:32Z
**Fixed**:
**Test run**: ~/wt-usage-tests/2026-02-25T05-57-32Z/

### Description

`wt stash drop <branch> </dev/null` still crashes with exit 13 and Node.js warning "Detected unsettled top-level await". This was previously reported as BUG-010 and marked "fixed", but the fix was incomplete.

The fix in `src/commands/stash.ts` added `process.stdin.once("close", onClose)` to `promptConfirm()`. However, when stdin is connected to `/dev/null`, Node.js stdin emits the `"end"` event (no more data) but **not** the `"close"` event — confirmed by direct Node.js test:

```
node -e "process.stdin.resume(); process.stdin.on('end',()=>console.log('end')); process.stdin.on('close',()=>console.log('close'));" </dev/null
# Output: end    (only "end" fires, "close" never fires)
```

Since `promptConfirm()` only registers a `"close"` listener (not `"end"`), the promise never resolves. The top-level `await cli.parseAsync()` remains pending, and Node.js exits with the unsettled-await warning (exit code 13).

**What happened**: `wt stash drop feature/e </dev/null` printed prompt, then crashed: `Warning: Detected unsettled top-level await ... exit 13`. Stash NOT dropped (safe), but exit code and warning are wrong.

**What should have happened**: When stdin reaches EOF with no data, `promptConfirm` should default to "N" and print "Aborted.", exiting cleanly (exit 0).

### Reproduction

```bash
# Set up a stash
wt checkout feature/g  # evicts dirty branch to create stash
wt stash list          # confirm stash exists
# Try to drop with non-interactive stdin
wt stash drop feature/e </dev/null
# Expected: "Drop stash for 'feature/e'? [y/N] Aborted." exit 0
# Actual:   "Drop stash for 'feature/e'? [y/N] Warning: Detected unsettled top-level await..." exit 13
```

### Fix

In `promptConfirm()` in `src/commands/stash.ts`, change the `"close"` listener to `"end"`:

```typescript
process.stdin.once("end", onClose);  // was: "close"
```

Or listen for both `"end"` and `"close"` to handle all non-interactive stdin cases.

### Vision reference

VISION.md §15.3 (error handling): commands should exit cleanly with appropriate codes. Exit 13 is non-standard.

---

## BUG-017: `wt init` from inside a worktree slot corrupts the slot

**Status**: fixed
**Found**: 2026-02-25T12:00:00Z
**Fixed**: 2026-02-25T05:58:00Z
**Test run**: ~/wt-usage-tests/2026-02-25T12-00-00Z/

### Description

Running `wt init` (without URL) from inside a worktree slot (which has a `.git` FILE — a git worktree link — rather than a `.git/` directory) corrupts the slot:

1. `init` checks for `.git` existence with `fs.access`, which returns `true` for both files and directories
2. `init` creates `.wt/repo/` inside the slot, then removes it (`rm`)
3. `init` renames the `.git` **file** (worktree link) to `.wt/repo` — the slot's `.git` file is now gone
4. `init` attempts `git config core.bare true` in `.wt/repo/`, which fails with `ENOTDIR` (`.wt/repo` is a file, not a directory)

After this, the slot directory has its `.git` link file gone (moved to `.wt/repo` inside the slot), and a partial `.wt/` structure has been created. The slot is no longer a valid git worktree.

**What happened**: Ran `wt init` from `fern-broad-crisp/` (a vacant slot in `my-project/`). Error: `"wt: Command failed with ENOTDIR: git config core.bare true. The 'cwd' option is not a directory: ...fern-broad-crisp/.wt/repo"`. The slot's `.git` file was moved to `fern-broad-crisp/.wt/repo` and `fern-broad-crisp/.wt/` partial structure was created.

**What should have happened**: `wt init` should detect that `.git` is a regular file (a worktree link), not a `.git/` directory (a real git repo root), and refuse with a clear message like: `"wt: Not a git repository root. Run 'wt init' from a regular git repository, not inside a worktree slot."` After the detection failure, no filesystem changes should be made.

### Reproduction

```bash
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p ~/wt-usage-tests/$TS && cd ~/wt-usage-tests/$TS
git init test-remote && cd test-remote && git commit --allow-empty -m "Initial commit" && cd ..
mkdir my-project && cd my-project
wt init "file://$(realpath ../test-remote)"
# Get a slot name
SLOT=$(ls | grep -v '\.wt')
# Now run init FROM INSIDE THE SLOT
cd $SLOT && wt init
# Observe: cryptic ENOTDIR error, slot .git file is gone
ls -la  # .wt/ directory present but .git file missing
```

### Vision reference

VISION.md §2.1: `wt init` from existing repository — "must be a git repository (.git/ must exist)" — the check should verify `.git` is a directory, not just that it exists as any file.

---

## BUG-016: Eviction fails when slot has unresolved merge conflicts from stash apply

**Status**: fixed
**Found**: 2026-02-23T14:25:00Z
**Fixed**: 2026-02-23T14:30:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T14-19-16Z/

### Description

When a slot has unresolved merge conflicts (from a prior `git stash apply` that produced conflicts), eviction of that slot fails because `git stash push --include-untracked` cannot operate on an index with unmerged entries:

```
error: could not write index
wt: Command failed with exit code 1: git stash push --include-untracked

shared-file.txt: needs merge
```

This blocks ALL subsequent `wt checkout` commands that would need to evict the conflicted slot. The user is stuck unless they manually resolve the conflicts in the slot first.

**What happened**: After `wt checkout feature/rebase-test` produced merge conflicts (stash from old base applied to new branch tip), the slot had `UU shared-file.txt` (unmerged). Attempting `wt checkout feature/epsilon` tried to evict the conflicted slot (it was LRU). `git stash push --include-untracked` failed with "error: could not write index" / "needs merge". Checkout failed with exit 1.

**What should have happened**: `wt` should detect the unmerged state before attempting eviction and provide a clear error message, such as: `"Cannot evict slot '<name>': unresolved merge conflicts exist. Resolve conflicts or run 'git checkout --merge .' in <slot> first."` Alternatively, `wt` could resolve the unmerged state automatically (e.g., `git add` the conflicting files in their current state before stashing, preserving the conflict markers as content).

### Reproduction

```bash
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p ~/wt-usage-tests/$TS && cd ~/wt-usage-tests/$TS

# Create remote with a branch
git init --bare test-remote.git
cd /tmp && git clone ~/wt-usage-tests/$TS/test-remote.git work
cd /tmp/work && echo "base" > shared.txt && git add . && git commit -m "init"
git checkout -b feature/conflict main && echo "conflict content" > shared.txt
git add . && git commit -m "conflict"
git push --all && cd ~/wt-usage-tests/$TS && rm -rf /tmp/work

# Init container, fill all 5 slots
mkdir my-project && cd my-project
wt init file://~/wt-usage-tests/$TS/test-remote.git
wt checkout feature/conflict

# Create dirty state and evict
echo "my changes" >> <slot>/shared.txt
# ... evict feature/conflict via LRU ...

# Force-push remote to new content
cd /tmp && git clone ~/wt-usage-tests/$TS/test-remote.git work2
cd /tmp/work2 && git checkout feature/conflict
echo "totally different" > shared.txt && git add . && git commit --amend -m "amended"
git push -f origin feature/conflict && rm -rf /tmp/work2

# Update local branch, checkout (conflict on stash apply)
cd ~/wt-usage-tests/$TS/my-project
git -C .wt/repo fetch origin
git -C .wt/repo branch -f feature/conflict origin/feature/conflict
wt checkout feature/conflict
# → "Stash for feature/conflict produced conflicts. Resolve manually."

# Now try to evict the conflicted slot
wt checkout some-other-branch
# → "error: could not write index" / "needs merge" (exit 1)
```

### Root cause

In `src/core/stash.ts`, `saveStash()` calls `git stash push --include-untracked` without first checking for unmerged index entries. Git's stash command cannot create a stash when the index has unmerged paths. The error propagates up and aborts the checkout.

### Fix

Before calling `git stash push`, check for unmerged entries via `git diff --name-only --diff-filter=U` (or check `git status --porcelain` for `UU`/`AA`/etc. prefixes). If unmerged entries exist:

1. **Option A (user-friendly error)**: Emit a clear error like `"Cannot evict '<slot>': unresolved merge conflicts. Resolve conflicts in <slot> first."` and skip eviction. Try the next LRU candidate slot instead, or fail if no other candidates exist.

2. **Option B (auto-resolve)**: Run `git add .` in the slot to mark all conflicts as resolved (preserving conflict markers as file content), then proceed with `git stash push --include-untracked`. This preserves the user's work-in-progress (including conflict markers) in the stash.

Option A is safer and more predictable. Option B risks confusing users who expect conflict markers to still be "unmerged" when they return.

### Vision reference

VISION.md §5.1: "If the slot has dirty state (any output from `git status`), create a stash." — Unmerged entries produce output from `git status`, so they are "dirty state" that should be stashed. However, `git stash push` cannot handle unmerged entries, creating an implementation gap.

VISION.md §15.2: "The stash ref and metadata are retained so the user can retry or inspect later." — The retained stash combined with unmerged state creates a slot that cannot be evicted.

---

## BUG-015: Slot with emptied directory (missing .git file) blocks all checkouts

**Status**: fixed
**Found**: 2026-02-23T14:10:00Z
**Fixed**: 2026-02-23T14:15:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T14-07-30Z/

### Description

When a slot directory exists but its contents are missing (specifically the `.git` worktree link file), `wt` reconciliation marks the slot as "(vacant)" because it cannot determine the branch. However, `wt checkout` then selects this corrupted slot for checkout (it appears vacant and is LRU-eligible), and the `git checkout` command fails because the directory is not a git repository:

```
fatal: not a git repository (or any of the parent directories): .git
fatal: not a git repository (or any of the parent directories): .git
wt: Command failed with exit code 128: git checkout -b feature/beta --track origin/feature/beta
```

This blocks ALL subsequent checkouts — wt always selects the same corrupted slot. Even though 3 other healthy vacant slots exist, they are never tried. The container is stuck until the user manually repairs or removes the corrupted slot directory.

**What happened**: After `rm -rf vault-lofty-dark/*` (emptying slot contents but leaving directory), every `wt checkout` fails with "fatal: not a git repository" (exit 1). The corrupted slot is always selected over healthy vacant slots.

**What should have happened**: Reconciliation should detect that the slot directory lacks a valid `.git` file and either:
1. Repair the slot by running `git worktree prune` and recreating it (same as the deleted-directory recovery path), or
2. Skip the corrupted slot and select a healthy vacant slot for checkout.

The deleted-directory case (entire slot dir removed) IS handled correctly — wt recreates it. The emptied-directory case (dir present, contents gone) is not.

### Reproduction

```bash
cd ~/wt-usage-tests/2026-02-23T14-07-30Z/my-project
# Slots: isle-firm-oak (main), vault-lofty-dark (vacant), quiet-bud-plum (vacant), ...

# Empty a slot's contents but leave the directory
rm -rf vault-lofty-dark/* vault-lofty-dark/.*

# wt list shows it as vacant (correct detection)
wt list
# → vault-lofty-dark  (vacant)  ...

# Checkout fails — always picks the corrupted slot
wt checkout feature/beta
# → fatal: not a git repository (exit 1)

# Try other branches — same failure every time
wt checkout feature/gamma
# → fatal: not a git repository (exit 1)
```

### Root cause

In reconciliation, when `git symbolic-ref HEAD` or `git rev-parse HEAD` fails for a slot (because there's no `.git` file), the slot is marked as vacant with no error. During checkout, the slot selection algorithm picks the LRU vacant slot. The corrupted slot is LRU (or first in order) and is always selected.

The checkout code then runs `git checkout -b <branch> --track origin/<branch>` in the corrupted slot directory, which fails because git doesn't recognize it as a repository.

The fix for deleted directories (in reconciliation) detects missing directories and recreates worktrees. But it doesn't check for an existing directory with a missing/invalid `.git` file.

### Fix

During reconciliation, for each slot directory that exists, verify that the `.git` file is present and valid (i.e., `fs.stat(path.join(slotDir, '.git'))` succeeds). If the `.git` file is missing:

1. Remove the empty directory
2. Run `git worktree prune` to clean up the stale worktree metadata
3. Recreate the slot via `git worktree add --detach`

This unifies the recovery path with the deleted-directory case.

### Vision reference

VISION.md §3.2 (Reconciliation): "wt silently updates internal state if direct git operations are detected." — A corrupted slot directory is a more severe case than a branch change, but the same principle applies: wt should recover gracefully.

---

## BUG-014: archiveStash loses untracked files — `git diff --binary` does not capture stash third parent

**Status**: fixed
**Found**: 2026-02-23T13:45:00Z
**Fixed**: 2026-02-23T14:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T13-42-08Z/

### Description

When `archiveStash` exports a stash to a patch file, it runs `git diff --binary <commit> <stash_ref>`. This produces a diff between the base commit and the stash merge commit's tree. However, a stash created with `git stash push --include-untracked` stores untracked files in a **third parent** of the stash commit, not in the main commit's tree. The `git diff` command only captures tracked file changes (staged and unstaged modifications to tracked files), silently dropping all untracked files from the archive.

**What happened**: Main slot had `staged-only.txt` (staged new file) and `archive-test-file.txt` (untracked). Slot was evicted, stash created with 3 parents (confirmed third parent contains `archive-test-file.txt`). Stash was archived via `wt fetch`. The resulting `.wt/stashes/archive/main.patch` only contains `staged-only.txt`. `archive-test-file.txt` is silently lost.

**What should have happened**: The archived patch file should contain ALL dirty state from the stash, including untracked files from the third parent. After archival, the patch should be a complete representation of the stash.

### Secondary issue

`wt stash show` on an archived stash returns "Stash is archived. Cannot show diff from archived stash." (exit 1). Since the archived patch file IS the diff, `wt stash show` should be able to display the patch file contents for archived stashes.

### Reproduction

```bash
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
mkdir -p ~/wt-usage-tests/$TS && cd ~/wt-usage-tests/$TS

# Create remote, init container
git init --bare test-remote.git
cd /tmp && git clone ~/wt-usage-tests/$TS/test-remote.git work
cd /tmp/work && echo "base" > file1.txt && git add . && git commit -m "init"
for b in feature/{a,b,c,d,e}; do git checkout -b $b main; echo "$b" > b.txt; git add . && git commit -m "$b"; done
git push --all && cd ~/wt-usage-tests/$TS && rm -rf /tmp/work
mkdir my-project && cd my-project
wt init file://~/wt-usage-tests/$TS/test-remote.git

# Fill all 5 slots
for b in feature/{a,b,c,d}; do wt checkout $b; done

# Create dirty state with untracked file in main slot
MAIN_SLOT=$(wt list | grep main | awk '{print $1}')
cd $MAIN_SLOT
echo "untracked content" > untracked-file.txt
echo "staged content" > staged-file.txt && git add staged-file.txt

# Evict main (create 6th branch to force eviction)
cd /tmp && git clone ~/wt-usage-tests/$TS/test-remote.git work2
cd /tmp/work2 && git checkout -b feature/f main && echo "f" > f.txt && git add . && git commit -m "f" && git push origin feature/f
cd ~/wt-usage-tests/$TS/my-project && rm -rf /tmp/work2
# Touch other slots to make main LRU
wt checkout feature/a && wt checkout feature/b && wt checkout feature/c && wt checkout feature/d
wt checkout feature/f  # evicts main

# Verify stash has both files
wt stash show main  # should show both staged-file.txt and untracked-file.txt

# Fake timestamp and delete remote branch to trigger archival
# Edit .wt/stashes/main.toml: set last_used_at to 10 days ago
# Delete main from remote
wt fetch  # triggers archival

# Check archive — untracked-file.txt is MISSING
cat .wt/stashes/archive/main.patch
# Only shows staged-file.txt, not untracked-file.txt
```

### Root cause

In `src/core/stash.ts` line 291-295, `archiveStash` runs:
```typescript
const diffResult = await execa("git", ["diff", "--binary", meta.commit, meta.stash_ref], { cwd: repoDir, ... });
```

`git diff <commit> <stash_ref>` compares the base commit tree against the stash commit's tree. The stash commit's tree only contains tracked files. Untracked files are stored in the stash's third parent (`<stash_ref>^3`), which `git diff` doesn't inspect.

### Fix

The archive export needs to also capture untracked files from the stash's third parent. Approach:

1. Check if the stash has a third parent: `git rev-parse --verify <stash_ref>^3`
2. If it does, export untracked files: `git diff-tree -r -p --binary --no-commit-id <stash_ref>^3` (diff the third parent's tree against the empty tree)
3. Concatenate both diffs into the patch file, separated by a marker comment (e.g., `# --- untracked files ---`)

Or use `git format-patch` / `git show` approaches that can handle the three-parent stash structure.

### Vision reference

VISION.md §5.3: "Archived — Compressed patch file (`.wt/stashes/archive/<branch>.patch.zst`) + metadata TOML." — The patch file must contain all dirty state (staged, unstaged, AND untracked) to be a faithful archive.

VISION.md §5.1: "Dirty state is defined as everything that appears in `git status`: staged changes, unstaged changes, and untracked files."

---

## BUG-013: Generated config.toml prevents adding templates via documented `[[templates]]` syntax

**Status**: fixed
**Found**: 2026-02-23T13:30:00Z
**Fixed**: 2026-02-23T13:35:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T13-27-42Z/

### Description

`wt init` generates a `config.toml` containing `templates = []` (a TOML inline array assignment). When a user later edits the file to add templates using the `[[templates]]` array-of-tables syntax shown in VISION §10, the TOML parser rejects the file:

```
wt: Invalid TOML document: trying to redefine an already defined table or value

8:  [[templates]]
      ^
9:  source = "templates/env.test"
```

**What happened**: After `wt init`, the generated config.toml contains `templates = []`. User appended:
```toml
[[templates]]
source = "templates/env.test"
target = ".env.test"
```
Running `wt sync` failed with "Invalid TOML document: trying to redefine an already defined table or value" (exit 1).

**What should have happened**: Users should be able to add templates using the `[[templates]]` syntax documented in VISION §10 without needing to first manually remove the `templates = []` line.

### Root cause

In `src/core/config.ts`, `writeConfig()` serializes the config with `smol-toml`'s `stringify()`. When `templates` is an empty array, `stringify` outputs `templates = []`. In TOML, once a key is defined as a simple value (`templates = []`), it cannot be redefined using array-of-tables syntax (`[[templates]]`). The two syntaxes are mutually exclusive for the same key.

### Reproduction

```bash
mkdir test-proj && cd test-proj
wt init <url>
cat .wt/config.toml
# → contains: templates = []

# Append templates per VISION §10 syntax:
cat >> .wt/config.toml <<'EOF'

[[templates]]
source = "templates/env.test"
target = ".env.test"
EOF

wt sync
# → wt: Invalid TOML document: trying to redefine an already defined table or value (exit 1)
```

### Fix

In `writeConfig()`, when `templates` is empty, omit the `templates` key entirely instead of writing `templates = []`. When `templates` has entries, `smol-toml`'s `stringify` should produce the correct `[[templates]]` array-of-tables format. Alternatively, construct the TOML data object such that empty arrays of tables are not serialized. Example fix:

```typescript
const data: Record<string, unknown> = {
  slot_count: config.slot_count,
  archive_after_days: config.archive_after_days,
  shared: { directories: config.shared.directories },
};
if (config.templates.length > 0) {
  data.templates = config.templates;
}
```

### Vision reference

VISION.md §10 (Configuration): Shows the documented way to configure templates using `[[templates]]` array-of-tables syntax. The generated config.toml must be compatible with this syntax.

---

## BUG-012: `wt init <url>` fails when remote default branch is not "main" or "master"

**Status**: fixed
**Found**: 2026-02-23T21:30:00Z
**Fixed**: 2026-02-23T22:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T21-30-00Z/

### Description

When `wt init <url>` is run against a remote whose default branch is something other than "main" or "master" (e.g., "develop"), initialization fails with:

```
fatal: invalid reference: origin/master
wt: Command failed with exit code 128: git worktree add --detach <path> origin/master
```

**What happened**: `wt init file:///path/to/remote-repo.git` (where default branch is "develop") cloned, fetched, then tried to create worktree slots detached at `origin/master` — which doesn't exist. Exit 1.

**What should have happened**: `wt init` should detect the remote's actual default branch ("develop") and create worktree slots detached at `origin/develop`. Initialization should succeed.

### Root cause

In `src/core/git.ts`, `defaultBranch()` tries three approaches in sequence:
1. `git symbolic-ref refs/remotes/origin/HEAD --short` — fails because `refs/remotes/origin/HEAD` is never set after a bare clone + fetch (bare clones don't create this ref automatically).
2. Falls back to checking `refs/remotes/origin/main` — doesn't exist.
3. Falls back to returning `"master"` unconditionally — doesn't exist either.

The fallback chain assumes the default branch is either "main" or "master", which is not always true.

### Reproduction

```bash
# Create a remote with "develop" as default branch
git init --bare --initial-branch=develop /tmp/test-remote.git
git clone /tmp/test-remote.git /tmp/work && cd /tmp/work
git checkout -b develop && echo "content" > file.txt && git add . && git commit -m "init"
git push -u origin develop && cd /tmp

# Try wt init
mkdir /tmp/my-project && cd /tmp/my-project
node /workspace/bin/wt.mjs init file:///tmp/test-remote.git
# → fatal: invalid reference: origin/master
# → exit 1
```

### Fix

After the fetch in `initFromUrl()` (src/commands/init.ts, line 188), run `git remote set-head origin --auto` to set `refs/remotes/origin/HEAD` based on the remote's actual HEAD. This makes `git symbolic-ref refs/remotes/origin/HEAD --short` work correctly in `defaultBranch()`.

Alternatively, improve the fallback in `defaultBranch()`: instead of blindly returning "master", enumerate all `refs/remotes/origin/*` branches and pick the first one (or raise a clear error if none exist).

### Vision reference

VISION.md §2.2: "Create all configured worktree slots (default: 5) via `git worktree add --detach`, each detached at `origin/main` (or the remote default branch)." — The parenthetical "(or the remote default branch)" explicitly requires detecting the actual default branch, not assuming it is "main" or "master".

---

## BUG-011: TUI crashes with unhandled Ink error when stdin is not a TTY

**Status**: fixed
**Found**: 2026-02-23T18:00:00Z
**Fixed**: 2026-02-23T19:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T18-00-00Z/

### Description

Running `wt` with no arguments inside a wt-managed container (or worktree slot) when stdin is not a TTY causes Ink to crash with an unhandled exception and a raw stack trace:

```
Error: Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.
Read about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported
    at file:///workspace/node_modules/.pnpm/ink@6.8.0.../build/components/App.js:117:23
    ...
```

Exit code 1 with a multi-line stack trace. This is confusing and unfriendly.

**What happened**: `wt` (no args) inside a worktree slot with non-TTY stdin printed a partial TUI render, then crashed with Ink's "Raw mode is not supported" error and a full Node.js stack trace.

**What should have happened**: `wt` should detect that stdin does not support raw mode before attempting to launch the TUI. If raw mode is unavailable, it should either:
1. Fall back to displaying CLI help/usage (same as when outside a container), or
2. Print a clean error message like `"wt: TUI requires an interactive terminal. Use 'wt <command>' for CLI usage."` and exit with code 1.

No stack trace should be shown to the user.

### Reproduction

```bash
cd ~/wt-usage-tests/2026-02-23T18-00-00Z/my-project/bison-dawn-thaw
node /workspace/bin/wt.mjs 2>&1
# → partial TUI render, then Ink crash with "Raw mode is not supported" + stack trace
# → exit 1
```

Or more simply: pipe stdin from /dev/null:
```bash
node /workspace/bin/wt.mjs < /dev/null
```

### Fix

Before rendering the Ink TUI, check `process.stdin.isTTY`. If it is not truthy, skip the TUI and either display help or print a friendly error. Example:

```typescript
if (!process.stdin.isTTY) {
  console.error("wt: TUI requires an interactive terminal. Use 'wt <command>' for CLI usage.");
  process.exit(1);
}
```

This check should be placed in the CLI entry point (src/cli.ts) in the default command handler, before `render(<App />)` is called.

### Vision reference

VISION.md §8: "`wt` with no arguments opens a fullscreen TUI if the current working directory is inside a `wt`-managed container or worktree. If not, it displays CLI help/usage." — The TUI is a terminal feature; graceful degradation when no terminal is available is implied.

---

## BUG-010: `wt stash drop` hangs/crashes when stdin is non-interactive (no data)

**Status**: fixed
**Found**: 2026-02-24T14:00:00Z
**Fixed**: 2026-02-23T12:37:00Z
**Test run**: ~/wt-usage-tests/2026-02-24T14-00-00Z/

### Description

`wt stash drop` (and `wt clean`) use a `promptConfirm()` helper that listens for a `"data"` event on `process.stdin`. When stdin is non-interactive (e.g., redirected from `/dev/null`, a closed pipe, or any context where stdin reaches EOF without sending data), the `"data"` event never fires. The Promise returned by `promptConfirm()` never resolves, and Node.js exits with a non-standard exit code and warning:

```
Drop stash for 'main'? This cannot be undone. [y/N] Warning: Detected unsettled top-level await at file:///workspace/dist/cli.js:949
await cli.parseAsync();
^

(exit code 13)
```

The stash is NOT dropped (which is safe), but:
1. Exit code 13 is non-standard — scripts expecting exit 0 (aborted) or 1 (error) will misinterpret this
2. The Node.js "unsettled top-level await" warning is confusing noise
3. The behavior is a crash rather than a clean abort

**What happened**: `timeout 5 wt stash drop main </dev/null` printed the prompt, then immediately crashed with exit code 13 and the Node.js warning.

**What should have happened**: When stdin is non-interactive (EOF with no data), `promptConfirm` should default to "N" and print "Aborted." cleanly, exiting with code 0 (or 1).

### Reproduction

```bash
cd /some/wt-container
# Ensure there is a stash for 'main' (create dirty state and evict main slot)
wt stash drop main </dev/null
# → prints prompt, then Node.js "unsettled top-level await" warning, exit 13
```

### Root cause

In `src/commands/stash.ts`, `promptConfirm()` only attaches a `"data"` event listener:
```typescript
process.stdin.once("data", (chunk: string) => { ... resolve(...) });
```
It does not handle `"close"`, `"end"`, or `"error"` events. When stdin closes without data (EOF), the promise is permanently unsettled. Node.js detects this during shutdown and emits the "unsettled top-level await" warning.

### Fix

In `promptConfirm()`, also listen for the `"close"` (or `"end"`) event and resolve `false` (defaulting to "N"):
```typescript
process.stdin.once("data", (chunk: string) => {
  process.stdin.removeListener("close", onClose);
  process.stdin.pause();
  resolve(chunk.trim().toLowerCase() === "y" || chunk.trim().toLowerCase() === "yes");
});
const onClose = () => resolve(false);
process.stdin.once("close", onClose);
```
Alternatively, check `process.stdin.isTTY` before prompting and abort immediately with a message like "wt: stdin is not a terminal. Use --yes to confirm destructive operations."

### Vision reference

VISION.md §9 (CLI Commands): `wt stash drop` and `wt clean` are described as interactive operations. Graceful degradation when non-interactive is implied by good CLI design.

---

## BUG-009: `wt checkout` fails when target slot has a shared symlink the target branch git-tracks

**Status**: fixed
**Found**: 2026-02-24T12:00:00Z
**Fixed**: 2026-02-24T13:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-24T12-00-00Z/

### Description

When `wt checkout <branch>` is called and the target slot already contains a shared symlink (e.g. `.config/app.json -> ../../.wt/shared/.config/app.json`) for a file that is **git-tracked** in `<branch>`, git refuses to check out:

```
error: The following untracked working tree files would be overwritten by checkout:
	.config/app.json
Please move or remove them before you switch branches.
Aborting
fatal: a branch named 'feature/tracked-config' already exists
wt: Command failed with exit code 128
```

**What happened**: `wt checkout feature/tracked-config` returned exit 1 with git's error; the slot was not checked out.

**What should have happened**: Checkout succeeds. The shared symlink is removed before `git checkout` runs (it is managed infrastructure, not user data), and step 12 (establish symlinks) correctly skips creating it because the branch tracks the file.

### Reproduction

```bash
# Init container with shared [.config] configured
wt init <remote>
# edit .wt/config.toml: [shared] directories = [".config"]
mkdir -p .wt/shared/.config && echo '{"shared":true}' > .wt/shared/.config/app.json
wt sync   # installs symlink in all slots including vacant ones

# Checkout a branch that has .config/app.json tracked in git
wt checkout feature/tracked-config
# → error: The following untracked working tree files would be overwritten by checkout:
#        .config/app.json
```

### Root cause

In `src/commands/checkout.ts`, the git checkout (step 9) runs before symlink reconciliation (step 12). The eviction block (step 8) only removes symlinks if the slot has dirty state (via `saveStash` → `removeSymlinks`). For **vacant slots** or **clean slots being evicted**, symlinks are left in place, causing git to refuse the checkout.

### Fix

Before `git.checkout(worktreeDir, ...)` in step 9, call `removeSymlinks(paths.wtDir, worktreeDir, config.shared.directories)` to clear all managed symlinks from the target slot. Step 12 will re-establish them after checkout (skipping any file that the new branch tracks).

### Vision reference

VISION.md §6.3: "When the user switches that worktree to a branch where the file is not tracked, the symlink is established." Implies that on checkout to a branch that **does** track the file, the symlink must not be present. The implementation must ensure this before git sees the working tree.

---

## BUG-008: archiveStash leaks "fatal: this operation must be run in a work tree"

**Status**: fixed
**Found**: 2026-02-23T24:00:00Z
**Fixed**: 2026-02-24T08:15:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T24-00-00/

### Description

When `wt fetch` (or `wt checkout`) triggers the archive scan and archives a stash, `archiveStash` in `src/core/stash.ts` first tries to export the stash patch via `git.stashShow(repoDir, meta.stash_ref)`. The `repoDir` argument is the bare repo at `.wt/repo/`. However, `git stash show` requires a work tree context and cannot be run from a bare repository. It emits:

```
fatal: this operation must be run in a work tree
```

This error leaks to the user's terminal via inherited stderr (`stdio: ["ignore", "pipe", "inherit"]` in `stashShow`). After the error, the try/catch in `archiveStash` falls back to `git diff --binary <commit> <stash_ref>`, which works correctly in a bare repo, and the archive succeeds. The bug is purely the leaked stderr output — the archive is created correctly.

**What happened**: `wt fetch` output included:
```
fatal: this operation must be run in a work tree
Warning: zstd not found. Archived stash stored uncompressed.
Archived 1 stash(es): feature/alpha
```

**What should have happened**: No `fatal:` output. The archive should succeed silently (with only the "Archived N stash(es)" summary).

### Reproduction

```bash
# 1. Init a container, checkout a branch, create dirty state
mkdir test && cd test
wt init <url>
wt checkout feature/x
echo "dirty" > untracked.txt

# 2. Evict the branch (force via checkout of new branch when all slots full)
# ... fill slots, checkout another branch to evict feature/x ...

# 3. Fake the stash timestamp to 8+ days ago
# Edit .wt/stashes/feature--x.toml: set last_used_at to an old date

# 4. Delete the remote branch
git -C .wt/repo branch -D feature/x   # or via remote

# 5. Run wt fetch
wt fetch
# → "fatal: this operation must be run in a work tree"
# → "Warning: zstd not found. Archived stash stored uncompressed."
# → "Archived 1 stash(es): feature/x"
```

### Vision reference

VISION.md §15.3: "All git errors are passed through to the user verbatim" — this applies to user-initiated operations, not internal archive machinery. The `git stash show` failure is expected (bare repo) and already handled by the fallback. The error should not leak.

### Fix

In `archiveStash` (src/core/stash.ts), the primary approach using `git stash show` will always fail in a bare repo. Since the bare repo is always used here, either:

1. **Skip `git stash show` entirely** in `archiveStash` — always use the `git diff --binary <commit> <stash_ref>` fallback, which works correctly in a bare repo.
2. **Suppress stderr** in `stashShow` when called from `archiveStash` — add an options parameter controlling stderr behavior.

Option 1 is simpler. The `git stash show` path is unnecessary since we always operate on the bare repo in `archiveStash`. Change `archiveStash` to directly call `git diff --binary` instead of first trying `git stash show`.

---

## BUG-007: Stash apply fails for shared symlinks — "already exists, no checkout"

**Status**: fixed
**Found**: 2026-02-23T22:00:00Z
**Fixed**: 2026-02-23T23:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T22-00-00/

### Description

When a slot is evicted, `wt` saves dirty state via `git stash push --include-untracked`. This captures ALL untracked files, including symlinks created by `wt sync` for configured `[shared] directories`. These shared symlinks are wt-managed infrastructure — not user state — but they are saved into the stash because they are untracked.

When the slot is later re-used for the same branch (or any branch), `wt checkout` runs symlink reconciliation (step 9) to set up shared symlinks BEFORE applying the saved stash. Then when `wt` calls `git stash apply <stash-ref>`, git attempts to restore the untracked symlinks from the stash, but finds they already exist (created by wt sync), and emits:

```
.config/app.json already exists, no checkout
error: could not restore untracked files from stash
```

`wt` then reports "Stash applied with conflicts. Resolve manually, then run 'wt stash drop ...'." — misleadingly presenting an infrastructure conflict as a user-caused merge conflict. Importantly, the tracked-file portion of the stash (merge conflicts in `.git`-tracked files) IS applied, so the user sees real merge conflict markers in tracked files alongside the confusing error about the symlink.

**What happened**: Running `wt stash apply feature/conflict-test` printed:
```
.config/app.json already exists, no checkout
error: could not restore untracked files from stash
wt: Stash for feature/conflict-test produced conflicts. Resolve manually.
```
Exit code 0, stash retained.

**What should have happened**: The shared symlinks (managed by `wt sync`) should NOT be included in the stash at all — they are always recreated by wt on checkout. The stash should only capture user-created untracked files. As a result, stash apply should not encounter the "already exists" failure for shared symlinks.

### Reproduction

```bash
# 1. Init a container from a remote
mkdir test && cd test
wt init <url>

# 2. Configure a shared directory
echo '[shared]\ndirectories = [".config"]' >> .wt/config.toml
mkdir -p .wt/shared/.config
echo '{"key":"value"}' > .wt/shared/.config/app.json

# 3. Checkout a branch into a slot
wt checkout feature/x

# 4. Create dirty state in the slot (modified tracked file)
echo "changes" >> <slot>/some-tracked-file.txt

# 5. Evict the slot by checking out new branches until all slots are full + 1
wt checkout feature/y  # (when all slots are full)

# 6. Re-checkout feature/x (skip auto-apply to demonstrate manual path)
wt checkout --no-restore feature/x

# 7. Apply stash
wt stash apply feature/x
# → ".config/app.json already exists, no checkout"
# → "error: could not restore untracked files from stash"
# → "wt: Stash for feature/x produced conflicts. Resolve manually."
```

### Vision reference

VISION.md §5.1: "Dirty state (staged, unstaged, untracked) is stashed" — but shared symlinks are wt-managed infrastructure, not user dirty state. They should be excluded.

VISION.md §6.2: shared files are always recreated by `wt sync` on checkout — making them redundant (and harmful) in stashes.

### Fix

Before `git stash push --include-untracked`, exclude paths that are managed shared symlinks. The fix should be applied in the stash-save code path (slot eviction). Two approaches:

1. **Pathspec exclusion**: run `git stash push --include-untracked -- ':(exclude).config/*' ...` for each configured shared directory — but this is fragile if shared dirs aren't known at eviction time.

2. **Pre-stash cleanup (preferred)**: Before saving the stash, remove managed shared symlinks from the worktree (they are reproducible from `.wt/shared/` at any time). After saving the stash, do NOT re-create them — they will be created by wt sync during the next checkout. This ensures the stash contains only genuine user state.

3. **Alternative**: Before calling `git stash apply`, delete all currently-present managed shared symlinks in the slot. After `git stash apply` succeeds or conflicts, run `wt sync` to re-create them. This avoids the "already exists" error.

---

## BUG-006: BUG-005 fix not applied to binary — dist not rebuilt after source fix

**Status**: fixed
**Found**: 2026-02-23T20:00:00Z
**Fixed**: 2026-02-23T21:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T20-00-00/

### Description

The fix for BUG-005 (`src/core/git.ts` — change `isTracked` stderr from `"inherit"` to `"pipe"`) was committed at 07:45:59 but `pnpm build` was never run afterward. The compiled binary at `dist/chunk-EHB43JQC.js` still has the old code:

```js
stdio: ["ignore", "pipe", "inherit"],  // OLD — stderr leaks
```

The source has the correct fix:
```js
stdio: ["ignore", "pipe", "pipe"],     // FIXED — stderr suppressed
```

**What happened**: Running `wt sync` with a shared `.claude` directory still prints git error lines to the terminal: `error: pathspec '.claude/CLAUDE.md' did not match any file(s) known to git` — identical to the original BUG-005 symptom.

**What should have happened**: No error output, since the BUG-005 fix was marked as applied.

### Reproduction

```bash
cd /any/wt-container
# Configure [shared] directories = [".claude"] with canonical files
node /workspace/bin/wt.mjs sync
# → "error: pathspec '.claude/CLAUDE.md' did not match any file(s) known to git" × N
```

Or: `grep "stdio" /workspace/dist/chunk-EHB43JQC.js` — the `isTracked` function still shows `"inherit"` for stderr.

### Vision reference

VISION.md §15.3: internal git operations should not leak stderr to the user's terminal.

### Fix

Run `pnpm build` in `/workspace` to recompile the TypeScript source into dist. The source already contains the correct fix.

---

## BUG-005: Internal git stderr leaked during shared symlink conflict check

**Status**: fixed
**Found**: 2026-02-23T16:00:00Z
**Fixed**: 2026-02-23T17:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T16-00-00/

### Description

When `wt sync` or `wt checkout` reconciles shared symlinks, `wt` internally checks whether each file is git-tracked in the worktree (Section 6.3 conflict detection). The implementation runs a git command (likely `git show HEAD:<path>` or `git ls-files --error-unmatch <path>`) with inherited stderr. For untracked files — which is the normal case, since shared files are expected to be gitignored — git emits:

```
error: pathspec '.claude/CLAUDE.md' did not match any file(s) known to git
Did you forget to 'git add'?
error: pathspec '.claude/settings.json' did not match any file(s) known to git
Did you forget to 'git add'?
```

These messages are printed once per shared file per slot on every `wt sync` and on every `wt checkout` (during step 9, symlink reconciliation). With 2 shared files and 5 slots, `wt sync` produces 10 such error lines. The symlinks are correctly created despite the error output — the bug is purely the stderr leakage.

**What happened**: `wt sync` printed `error: pathspec '.claude/CLAUDE.md' did not match any file(s) known to git` 10 times (2 files × 5 slots) before correctly creating all symlinks.

**What should have happened**: No git error output for internal git-tracked conflict checks. The "git errors pass through verbatim" rule (VISION §15.3) applies to user-initiated git operations, not internal state queries.

### Reproduction

```bash
mkdir symlink-test && cd symlink-test
wt init <url>
# Configure [shared] directories = [".claude"] in .wt/config.toml
mkdir -p .wt/shared/.claude
echo '{}' > .wt/shared/.claude/settings.json
wt sync
# → "error: pathspec '.claude/settings.json' did not match any file(s) known to git" × 5 (one per slot)
wt checkout <branch>
# → same error messages during symlink reconciliation (step 9)
```

### Vision reference

VISION.md §6.3: "If a file is configured as shared but is tracked by git in the current branch of a worktree: Git wins. The symlink is not created."

VISION.md §15.3: "All git errors are passed through to the user verbatim" — this applies to user-initiated operations (`git checkout`, `git fetch`, `git stash apply`), not internal state queries like checking whether a file is git-tracked.

### Fix

In the shared symlink reconciliation code, suppress stderr when running the internal git check for tracked files (use `stdio: ["ignore", "pipe", "pipe"]` or `stderr: 'pipe'`). A non-zero exit code simply means the file is not tracked — the symlink should be created. The error text itself is irrelevant internal noise.

---

## BUG-004: `--no-restore` flag rejected by yargs strict mode ("Unknown argument: restore")

**Status**: fixed
**Found**: 2026-02-23T12:00:00Z
**Fixed**: 2026-02-23T13:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T12-00-00/

### Description

`wt checkout --no-restore <branch>` fails immediately with:

```
wt checkout <branch>
...
Unknown argument: restore
```

The flag `--no-restore` is defined in the CLI via `.option("no-restore", { type: "boolean", default: false })`. However, yargs has a built-in boolean-negation convention: any `--no-X` flag is interpreted as "set `X` to false". In strict mode, yargs parses `--no-restore` as "negate the `restore` option" and then rejects `restore` as an unknown argument (because only `no-restore` is defined, not `restore`).

**What happened**: Running `wt checkout --no-restore fix/bug-123` printed the help text and "Unknown argument: restore" with exit code 1.

**What should have happened**: The checkout should proceed without auto-restoring the stash for the target branch.

**Workaround**: `--noRestore` (camelCase) is accepted by yargs but is not the documented interface.

### Reproduction

```bash
cd /some/wt-container
# Create a stash on some branch, then:
wt checkout --no-restore <branch>
# → Unknown argument: restore (exit 1)
```

### Vision reference

VISION.md §3.1, step 7: "If `--no-restore` was passed, the stash is preserved but not applied."
VISION.md §9 (CLI Commands table): `wt checkout <branch>` … "Supports `--no-restore` to skip automatic stash restoration."

### Fix

In `src/cli.ts`, change the `checkout` command option from:
```typescript
.option("no-restore", { type: "boolean", default: false, describe: "..." })
```
to:
```typescript
.option("restore", { type: "boolean", default: true, describe: "Auto-restore stash on checkout (use --no-restore to skip)" })
```
Then in the handler, change `noRestore: argv["no-restore"]` to `noRestore: !argv.restore`. Yargs's boolean-negation mechanism will then correctly parse `--no-restore` as `restore = false`.

---

## BUG-003: Shell function causes infinite recursion → segfault due to `command -v wt` returning function name

**Status**: fixed
**Found**: 2026-02-23T09:00:00Z
**Fixed**: 2026-02-23T10:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T09-00-00/

### Description

The shell function emitted by `wt shell-init bash` (and `shell-init zsh`) uses `command -v wt` to locate the `wt` binary before calling it. However, once the function is `eval`'d into the shell, `wt` is a shell function — and `command -v wt` in bash returns `wt` (the function name) rather than the binary path when a shell function with that name exists. The function then calls `"$wt_bin" "$@"` which resolves to `wt checkout ...`, which calls the shell function again, causing infinite recursion and an eventual bash stack overflow (segfault, exit 139).

**What happened**: After `eval "$(wt shell-init bash)"`, running `wt checkout <branch>` segfaulted with exit code 139.

**What should have happened**: The shell function should call the `wt` external binary (bypassing the shell function itself), navigate to the checkout target, and return the binary's exit code.

### Reproduction

```bash
export PATH="/path/to/wt/bin:$PATH"
eval "$(wt shell-init bash)"
cd /some/wt-container
wt checkout some-branch
# → segfault (exit 139), bash stack overflow from infinite recursion
```

### Vision reference

VISION.md Shell Integration section: `eval "$(wt shell-init <shell>)"` defines a `wt()` shell function that calls the `wt` binary and then reads a nav file to `cd` to the checked-out worktree directory.

### Fix

In `src/commands/shell-init.ts`, replace the pattern:
```bash
local wt_bin
wt_bin="$(command -v wt)" || { echo "wt: binary not found" >&2; return 1; }
"$wt_bin" "$@"
```
with:
```bash
command wt "$@"
```
`command wt` in bash/zsh explicitly bypasses shell functions and invokes the external `wt` binary directly. If no external binary is found, bash/zsh emit a "not found" error naturally. The same fix applies to the fish script: replace `$wt_bin $argv` with `command wt $argv`.

---

## BUG-002: "fatal: ref HEAD is not a symbolic ref" printed for every vacant slot during reconciliation

**Status**: fixed
**Found**: 2026-02-23T08:00:00Z
**Fixed**: 2026-02-23T08:30:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T08-00-00/

### Description

Every `wt` command that triggers reconciliation (i.e., all commands) calls `git.currentBranch(slotPath)` for each worktree slot directory. `currentBranch` runs `git symbolic-ref --short HEAD` with `stdio: ["ignore", "pipe", "inherit"]`, which means git's stderr is inherited by the process. When a slot is in detached HEAD state (vacant slots always are), this command fails with:

```
fatal: ref HEAD is not a symbolic ref
```

This error is printed once per vacant slot to the user's terminal, regardless of which `wt` command they run. With 5 slots and 4 vacant, the user sees this message 4 times on every `wt list`, `wt checkout`, etc.

**What happened**: Running `wt list` on a fresh container with 5 slots (1 on `main`, 4 vacant) printed "fatal: ref HEAD is not a symbolic ref" 4 times before showing the slot table.

**What should have happened**: No git error output for internal state-checking operations. The "git errors pass through verbatim" rule in VISION.md §15.3 applies to user-initiated git operations (checkout, fetch, stash apply), not internal reconciliation queries.

### Reproduction

```bash
mkdir my-project && cd my-project
wt init file:///path/to/remote.git
wt list
# Output: 4 × "fatal: ref HEAD is not a symbolic ref" before the slot table
```

### Vision reference

VISION.md §15.3: "All git errors are passed through to the user verbatim. `wt` does not wrap, reinterpret, or suppress git error messages. If `git checkout`, `git fetch`, `git stash apply`, or any other git operation fails, the user sees git's native error output."

The key phrase is "if `git checkout`, `git fetch`, `git stash apply`, **or any other git operation** fails" — this refers to user-facing operations, not internal state queries like `git symbolic-ref HEAD` used to determine whether a slot is detached. The fix is to pipe stderr for `currentBranch` (and any other internal-only git calls) rather than inheriting it.

### Fix

In `src/core/git.ts`, change `currentBranch` to use `stdio: ["ignore", "pipe", "pipe"]` (or `stderr: 'pipe'`) so that the expected failure for detached HEAD is silently discarded. The function already returns `null` on failure; the stderr output is noise.

---

## BUG-001: Untracked files lost during slot eviction (stash create does not include untracked)

**Status**: fixed
**Found**: 2026-02-23T07:05:00Z
**Fixed**: 2026-02-23T07:20:00Z
**Test run**: ~/wt-usage-tests/2026-02-23T10-00-00/

### Description

When a slot is evicted (LRU eviction on checkout), `wt` saves dirty state via `git stash create --include-untracked`. The expectation per the vision is that staged, unstaged, AND untracked files are all saved in the stash. However, `git stash create --include-untracked` in git 2.47.3 (and likely all recent versions) does NOT include untracked files — it only creates a 2-parent stash commit containing tracked changes.

In contrast, `git stash push --include-untracked` creates a proper 3-parent stash commit where the 3rd parent holds untracked files. `git stash apply` correctly restores the 3rd parent's tree when applying such stashes.

**What happened**: A slot with `auth.js` (modified), `staged.js` (staged), and `untracked.txt` (untracked) was evicted. After re-checking out the branch, `auth.js` and `staged.js` were restored, but `untracked.txt` was silently lost.

**What should have happened**: All three categories of dirty state should have been restored after re-checkout.

### Reproduction

```bash
# Init a container from a remote
mkdir my-project && cd my-project
wt init <some-repo-url>

# Fill all slots so eviction is needed
wt checkout branch-a

# Create dirty state with untracked file in branch-a slot
echo "untracked" > untracked.txt

# Checkout a new branch to trigger LRU eviction of branch-a
wt checkout branch-b  # (when slots are full)

# Re-checkout branch-a — untracked.txt should be restored, but it isn't
wt checkout branch-a
ls -la  # untracked.txt is missing
```

### Vision reference

VISION.md — "Dirty state (staged, unstaged, untracked) is stashed via `git stash create -u`, anchored with `refs/wt/stashes/*` refs, metadata in `.wt/stashes/`."

The vision's prescription of `git stash create -u` doesn't work for untracked files. The implementation needs to either:
1. Use `git stash push --include-untracked` then read back the resulting stash hash from `refs/stash`, OR
2. Manually collect untracked files and store them in a separate commit tree anchored with a ref alongside the main stash ref.
