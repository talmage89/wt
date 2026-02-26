# Bug Tracker

Bug numbers continue from the archived log. See `.docs/archive/BUGS.md` for BUG-001 through BUG-028.

Next bug number: **BUG-033**

## BUG-029: "Created local branch" message missing on remote-only branch checkout

**Status**: fixed
**Found**: 2026-02-26T07:30:00Z
**Re-opened**: 2026-02-26T13:00:00Z (prior fix ineffective — see updated root cause below)
**Test run**: ~/wt-usage-tests/2026-02-26T07-30-00/, ~/wt-usage-tests/2026-02-26T13-00-00/

### Description

When checking out a branch that exists only on the remote (e.g., `origin/remote-only-branch` but no local `refs/heads/remote-only-branch`), the `wt: Created local branch <branch> from origin/<branch>` message is never printed.

The message is supposed to appear per VISION.md section 3.2: "The 'Created local branch' line appears only when a new branch was created from remote."

### Root cause (corrected)

`wt` uses a bare repo (`.wt/repo/`) cloned with `git clone --bare`. `git clone --bare` maps ALL remote branches directly to `refs/heads/*` in the bare repo — there is no `refs/remotes/` distinction in the same sense as a normal clone. As a result, `git.refExists(repoDir, 'refs/heads/<branch>')` returns `true` for every branch that existed on the remote at clone time, even branches the user has never personally worked with.

The attempted fix (commit `cec6dbd`) set `localBranchExistedBefore` based on `refExists(repoDir, 'refs/heads/<branch>')`. Because bare clones pre-populate `refs/heads/` for all remote branches, `localBranchExistedBefore` is always `true` for any known remote branch, so `branchCreatedFromRemote` is never set.

### Correct fix

Use `branch_history` in `state.toml` instead of `refExists` to detect first-time checkout. `branch_history` tracks every branch the user has explicitly checked out via `wt`. A branch that has never been in `branch_history` is being worked with for the first time — i.e., "created from remote."

In `src/commands/checkout.ts`, section 7.5, replace:
```typescript
localBranchExistedBefore = localExists;
```
with:
```typescript
// BUG-029: bare clone creates refs/heads/* for all remote branches, so
// refExists is always true for known branches. Use branch_history to
// detect first-time checkout (i.e., "created from remote").
localBranchExistedBefore = state.branch_history.some(
  (e) => e.branch === options.branch
);
```

The `localExists` / `remoteBranchExists` checks above are still needed for BUG-028 (fail before eviction if branch not found anywhere). Only the `localBranchExistedBefore` assignment changes.

### Reproduction

```bash
# Set up a remote-only branch
git init --bare remote.git
git clone remote.git local-setup && cd local-setup
git config user.email "t@t.com" && git config user.name "T"
echo init > README.md && git add . && git commit -m "init"
git push origin main
git checkout -b remote-only && echo x > f && git add . && git commit -m "x"
git push origin remote-only && git checkout main && cd ..

# Init wt and checkout remote-only branch
mkdir proj && cd proj
wt init /path/to/remote.git
wt checkout remote-only

# Expected: prints "wt: Created local branch remote-only from origin/remote-only"
# Actual:   no "Created local branch" line printed
```

### Vision reference

VISION.md section 3.2 (Checkout Output):
> `wt: Created local branch feature/new from origin/main`
> The "Created local branch" line appears only when a new branch was created from remote.

---

## BUG-030: "Created local branch from origin/X" message appears incorrectly for local-only branches

**Status**: fixed
**Found**: 2026-02-26T20:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-26T20-00-00/

### Description

When checking out a branch for the first time via `wt`, the `wt: Created local branch <branch> from origin/<branch>` message appears even when the branch was created locally (not from a remote) or when there is no remote at all. The message is factually incorrect in these cases — there is no `origin/<branch>` to reference.

### Root cause

The BUG-029 fix uses `branch_history` as a proxy for detecting "first time checkout = created from remote":

```typescript
localBranchExistedBefore = state.branch_history.some(
  (e) => e.branch === options.branch
);
```

This is correct for the typical bare-clone workflow (all branches in refs/heads came from the remote), but fires incorrectly when:
1. The repo has no remote (wt init from a local-only git repo)
2. A branch was manually created in the bare repo via `git --git-dir=.wt/repo branch <name> <base>` (not via `wt checkout -b`)

In both cases, the branch was not "created from remote" yet `!localBranchExistedBefore` is true, causing the message to appear.

### Correct fix

After a successful checkout where `!localBranchExistedBefore`, additionally verify that a remote tracking ref actually exists for the branch:

```typescript
// Only set branchCreatedFromRemote if the remote branch exists.
// This prevents false positives for locally-created branches and no-remote repos.
if (!localBranchExistedBefore) {
  const remoteExists = await git.remoteBranchExists(paths.repoDir, options.branch);
  if (remoteExists) {
    branchCreatedFromRemote = true;
  }
}
```

This check runs `git ls-remote --heads origin <branch>` which correctly returns false when there's no remote or when the branch is local-only. The pre-check at step 7.5 already calls `remoteBranchExists` when `!localExists`; this fix adds a second call in the success path to guard the message.

### Reproduction

```bash
# Create a local-only repo (no remote)
git init local-only && cd local-only
git config user.email "t@t.com" && git config user.name "T"
echo "hello" > README.md && git add . && git commit -m "init"
wt init   # converts local repo to wt container

# Manually create a local branch in the bare repo
git --git-dir=.wt/repo branch feature/local-only main

# Checkout the local branch via wt
wt checkout feature/local-only

# Expected: "wt: Checked out feature/local-only in <slot>" (no "Created local branch" line)
# Actual:   "wt: Created local branch feature/local-only from origin/feature/local-only"
#           (WRONG: there is no remote and no origin/feature/local-only)
```

### Vision reference

VISION.md section 3.2 (Checkout Output):
> The "Created local branch" line appears only when a new branch was created from remote.

---

## BUG-031: `wt init <url>` leaves partial `.wt/` directory on clone failure, blocking retry

**Status**: fixed
**Found**: 2026-02-27T01:00:00Z
**Test run**: ~/wt-usage-tests/2026-02-27T01-00-00/

### Description

When `wt init <url>` is run and the git clone fails (e.g., bad URL, network error, auth failure), the `.wt/` directory structure has already been created before the clone attempt. The clone failure leaves a partial `.wt/` tree behind. Any subsequent `wt init <corrected-url>` in the same directory immediately fails with "Directory is not empty" because the partial `.wt/` makes the directory non-empty. The user is stuck and must manually `rm -rf .wt` before retrying.

### Root cause

In `src/commands/init.ts`, `initFromUrl()` calls `createContainerStructure(containerDir)` (line 194) to create the `.wt/` directory tree before running `git.cloneBare(url, repoDir)` (line 200). If the clone fails, the already-created `.wt/` directories are never cleaned up.

```typescript
// .wt/ is created here:
const wtDir = await createContainerStructure(containerDir);
const repoDir = join(wtDir, "repo");

// If this throws (e.g. bad URL), .wt/ is left behind:
await git.cloneBare(url, repoDir);
```

The non-empty directory check at line 186 correctly rejects non-empty dirs before init, but a subsequent retry hits this check because the partial `.wt/` from the failed attempt is still present.

### Correct fix

Wrap the clone (and all subsequent work) in a try/catch. On any error after `createContainerStructure`, remove the `.wt/` directory before re-throwing:

```typescript
const wtDir = await createContainerStructure(containerDir);
const repoDir = join(wtDir, "repo");

try {
  await git.cloneBare(url, repoDir);
  // ... rest of initFromUrl ...
} catch (err) {
  // Clean up partial .wt/ so the user can retry
  await rm(wtDir, { recursive: true, force: true });
  throw err;
}
```

### Reproduction

```bash
mkdir test-dir && cd test-dir
wt init http://not-a-real-git-repo.invalid/nonexistent.git
# Expected: fails with git error, directory remains usable for retry
# Actual: fails with git error AND leaves .wt/ behind

wt init https://github.com/real/repo.git
# Expected: succeeds (or fails for a different reason)
# Actual: "Directory is not empty. Use 'wt init' from inside an existing repository..."
```

### Vision reference

VISION.md §2.2 (Init from URL): the directory must be empty before init. After a failed clone, the directory is no longer empty, trapping the user.

VISION.md §15.3: git errors pass through verbatim — satisfied. The issue is the unrecoverable partial state left behind.

---

## BUG-032: Missing `.wt/stashes/` directory causes raw ENOENT crash on dirty eviction

**Status**: open
**Found**: 2026-02-26T09:18:12Z
**Test run**: ~/wt-usage-tests/2026-02-26T09-18-12Z/

### Description

If the `.wt/stashes/` directory is deleted (e.g., by an accidental `rm -rf`, `git clean`, or manual cleanup), any subsequent `wt checkout` that triggers eviction of a **dirty** slot fails with a cryptic raw Node.js error:

```
wt: ENOENT: no such file or directory, open '.wt/stashes/main.toml'
```

The error is unactionable (the user has no hint that the stashes directory is missing or how to fix it) and aborts the entire checkout operation, leaving the slot still assigned to the old dirty branch with no checkout performed.

### Root cause

`src/core/stash.ts` writes the stash metadata TOML file to `.wt/stashes/<encoded-branch>.toml` without first ensuring the directory exists. If `.wt/stashes/` was deleted (the directory is created by `createContainerStructure()` during `wt init` and is normally always present), the `fs.writeFile` call throws ENOENT.

### Correct fix

Before writing the stash metadata file in `saveStash()`, ensure the stashes directory exists:

```typescript
await mkdir(stashesDir, { recursive: true });
```

Similarly, the archive subdirectory `.wt/stashes/archive/` should also be auto-created before writing archive files. Using `{ recursive: true }` means no-op if the directory already exists, so this is a safe defense-in-depth fix.

### Reproduction

```bash
mkdir test-proj && cd test-proj
wt init <url>

# Fill all 5 slots
wt checkout branch-a && wt checkout branch-b && wt checkout branch-c
# (checkout 2 more to fill remaining slots)

# Add dirty state to the LRU slot
echo "dirty" >> some-file.txt

# Delete the stashes directory
rm -rf .wt/stashes/

# Trigger eviction of dirty slot
wt checkout branch-new
# Expected: evicts dirty slot, creates stash in recreated .wt/stashes/, checks out branch-new
# Actual:   "wt: ENOENT: no such file or directory, open '.wt/stashes/<branch>.toml'"
#           exit 1, checkout does not complete
```

### Vision reference

VISION.md §5.1: stash creation is an integral part of eviction. A missing directory is an infrastructure failure, not a user error — `wt` should recover transparently by recreating managed infrastructure directories.

VISION.md §15.1: `wt` should produce clear, actionable error messages. A raw ENOENT path is neither clear nor actionable.
