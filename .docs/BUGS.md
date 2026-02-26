# Bug Tracker

Bug numbers continue from the archived log. See `.docs/archive/BUGS.md` for BUG-001 through BUG-028.

Next bug number: **BUG-030**

## BUG-029: "Created local branch" message missing on remote-only branch checkout

**Status**: open
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
