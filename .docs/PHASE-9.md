# Phase 9: Continuous Usage Testing

**This phase is never complete.** It runs indefinitely after Phase 8. Every agent entering this phase performs one cycle of the loop described below.

**Depends on**: Phase 8 (all implementation complete, all unit/integration tests passing).

---

## Testing Location

All usage tests are performed in `~/wt-usage-tests/`. This directory is **never cleaned up** — it persists between agent sessions so that previous test artifacts can be inspected. Each test run creates a subdirectory named with a timestamp:

```
~/wt-usage-tests/
  2026-02-23T14-30-00/
    test-repo/              # a real git repo used as the remote
    my-project/             # the wt-managed container
  2026-02-23T15-45-00/
    ...
```

---

## Log File

All testing activity is recorded in `.docs/USAGE-TESTING.log` in the workspace. Each entry follows this format:

```
## <ISO timestamp>

Location: ~/wt-usage-tests/<run-dir>/
Tests performed:
- <brief description of what was tested>
- <brief description of what was tested>
Result: PASS | BUG FOUND
Bug: <if applicable, one-line summary referencing .docs/BUGS.md>
```

---

## Bug File

When a bug is discovered, it is recorded in `.docs/BUGS.md` with the following format:

```
## BUG-<NNN>: <short title>

**Status**: open | fixed
**Found**: <ISO timestamp>
**Fixed**: <ISO timestamp, if fixed>
**Test run**: ~/wt-usage-tests/<run-dir>/

### Description
<What happened vs. what should have happened, per the vision.>

### Reproduction
<Exact commands to reproduce.>

### Vision reference
<Which section of VISION.md defines the expected behavior.>
```

Bug numbers are sequential, starting at 001.

---

## Agent Loop

Every agent entering Phase 9 follows this exact sequence:

### 1. Check for open bugs

Read `.docs/BUGS.md`. If any bug has `Status: open`:

1. Implement the fix.
2. Write a targeted unit or integration test that catches the bug.
3. Run `pnpm test` — all tests must pass.
4. Update the bug entry: set `Status: fixed`, add `Fixed` timestamp.
5. Commit with message: `fix: BUG-<NNN> <short title>`.
6. **Stop. Exit.** Do not proceed to usage testing. The next agent will.

### 2. Review the log

Read `.docs/USAGE-TESTING.log`. Understand what has already been tested. Identify gaps — scenarios from the vision that have not yet been exercised, or areas that were only lightly covered. Prioritize untested or under-tested behavior.

### 3. Plan the test run

Choose 3-5 specific scenarios to test. Prioritize:
- Behavior described in the vision that hasn't been tested yet.
- Edge cases and peripheral behavior (not the happy path).
- Interactions between features (e.g., stash + pin + eviction together).
- Error conditions and recovery.

Examples of the kind of scenarios to target:

**Init edge cases:**
- `wt init` from a repo with dirty state and untracked files.
- `wt init <url>` into a directory that has a single dotfile.
- Running `wt init` twice.

**Checkout edge cases:**
- Checkout a branch that only exists on the remote (never local).
- Checkout a branch with `/` in the name (encoding).
- Checkout when the current slot is the LRU candidate.
- Checkout the same branch you're already on.
- Checkout with `--no-restore`, then manually `wt stash apply`.

**Eviction edge cases:**
- Evict a slot with staged changes, unstaged changes, AND untracked files.
- Evict, then restore on a branch that has been rebased since eviction.
- Evict all slots in sequence — verify stash metadata accumulates correctly.

**Pin edge cases:**
- Pin all slots, then try checkout — verify error.
- Pin from within a worktree vs. by slot name.
- Unpin and immediately evict.

**Symlink edge cases:**
- Shared file that is git-tracked on one branch but not another — verify symlink appears/disappears on checkout.
- Create a real file in a shared directory, run sync — verify migration.
- Delete the canonical file, run sync — verify broken symlinks cleaned.

**Template edge cases:**
- Template with `{{BRANCH_NAME}}` on a vacant (detached) slot.
- Modify a template source, run sync — verify all slots regenerated.

**Stash lifecycle:**
- Create a stash, wait (or fake the timestamp), delete the remote branch, run fetch — verify archival.
- Drop an archived stash — verify patch file deleted.
- `wt stash show` on a branch with no stash — verify error.
- `wt stash apply` on a branch not in any slot — verify error.

**Reconciliation:**
- Directly `git checkout` a different branch inside a slot, then run any `wt` command — verify state updates silently.
- Delete a slot directory, then run `wt list` — verify graceful handling.
- Manually `git worktree add` a new directory in the container — verify it appears or is ignored appropriately.

**Shell integration:**
- Verify nav file is written and cleaned up after checkout.
- Verify `wt shell-init bash` output defines a valid `wt()` function.
- Source the shell init and run a checkout — verify cwd changes.

**Slot count changes:**
- Increase slot_count in config, run a command — verify new slots appear.
- Decrease slot_count below current count — verify LRU eviction of excess.
- Decrease below pinned count — verify error.

**Concurrent/adversarial:**
- Run `wt checkout A` while another terminal has a file open in a slot.
- Corrupt `state.toml` (invalid TOML), run a command — verify recovery or clear error.

### 4. Execute the test run

1. Create the run directory: `mkdir -p ~/wt-usage-tests/<timestamp>/`.
2. Set up a real git repo to act as the remote (or clone a public repo).
3. Run `wt` commands as a real user would — via the built binary, not test harness.
4. Use the shell integration if testing shell behavior: `eval "$(node /workspace/bin/wt.mjs shell-init bash)"`.
5. Observe actual behavior. Compare against VISION.md.

### 5. Log results

Append to `.docs/USAGE-TESTING.log` with the standard format.

- If all tests pass: `Result: PASS`.
- If a bug is found: `Result: BUG FOUND`, log the bug in `.docs/BUGS.md`, and **stop immediately**. Do not continue testing. Do not fix the bug. Commit the log and bug file, then exit.

### 6. Commit and exit

Commit the updated log file (and bug file if applicable). Exit. The next agent will continue the loop.

---

## Principles

- **Test like a user, not a developer.** Use the built binary. Use the shell function. `cd` around. Make mistakes. Be adversarial.
- **Peripheral over happy-path.** The happy path is covered by unit and integration tests. Usage testing exists to find the weird stuff.
- **One agent, one cycle.** Do not run multiple test cycles in a single session. Do your 3-5 scenarios, log, commit, exit.
- **Never fix and test in the same session.** If you fixed a bug (step 1), exit. If you found a bug (step 5), exit. Separation prevents tunnel vision.
- **Persist everything.** Test directories in `~/wt-usage-tests/` are never deleted. They are evidence.
