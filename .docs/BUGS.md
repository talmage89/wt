# Bug Tracker

Bug numbers continue from the archived log. See `.docs/archive/BUGS.md` for BUG-001 through BUG-028.

Next bug number: **BUG-030**

## BUG-029: "Created local branch" message missing on remote-only branch checkout

**Status**: fixed
**Found**: 2026-02-26T07:30:00Z
**Test run**: ~/wt-usage-tests/2026-02-26T07-30-00/

### Description

When checking out a branch that exists only on the remote (e.g., `origin/remote-only-branch` but no local `refs/heads/remote-only-branch`), git's DWIM behavior makes `git checkout <branch>` succeed and automatically create a local tracking branch. However, the `wt: Created local branch <branch> from origin/<branch>` message is never printed.

The message is supposed to appear per VISION.md section 3.2: "The 'Created local branch' line appears only when a new branch was created from remote." A local tracking branch was created from the remote, but no message was shown.

**Root cause**: `branchCreatedFromRemote` is only set to `true` in the error-fallback code path (lines 234–236 of `src/commands/checkout.ts`). When git's DWIM makes the initial `git checkout <branch>` succeed (because `origin/<branch>` exists), the fallback is never reached and the flag is never set.

The fix is to pre-check whether the branch exists locally _before_ the checkout (the pre-validation section at lines 143–157 already computes this). If the branch did not exist locally before checkout and the checkout succeeds, set `branchCreatedFromRemote = true`.

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
