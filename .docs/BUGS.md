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
