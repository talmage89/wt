# Phase 1: UX Improvement Planning

**Goal**: Audit the existing CLI and TUI, produce a concrete spec for every UX improvement, and update VISION.md where needed.

**Depends on**: All core implementation complete (old Phases 1–8). All automated tests passing.

---

## Context

The CLI and TUI are functionally complete — every operation works. But the tool is uninformative: it assumes the user already understands worktrees, slots, stashing, eviction, and the `wt` mental model. There is no guidance after actions, no feedback during multi-step processes, and no help for first-time users. This phase designs the fixes.

---

## 1.1 Audit Existing UX

Walk through every user-facing flow and document what the user sees, what's missing, and what's confusing. Cover:

### CLI Commands

- **`wt init`**: What does the user see after init completes? Are they navigated to the right place? Do they know shell integration needs to be sourced? Do they know what the slot directories are?
- **`wt checkout <branch>`**: Is there feedback about what happened (eviction, stash save/restore, branch creation)? Is the cursor visible after checkout? Can the user create a new branch (`git checkout -b` equivalent)?
- **`wt list`**: Is the output self-explanatory? Does it help the user decide what to do next?
- **`wt fetch`**: Does it show progress? Does it explain what was archived?
- **`wt sync`**: Does it explain what changed?
- **`wt stash *`**: Are the subcommands discoverable?
- **`wt pin/unpin`**: Is there confirmation?
- **`wt clean`**: Is the interactive prompt clear?

### TUI Panels

- **Worktree Panel**: Does it show ALL known branches (including those created via direct `git checkout -b`)? Is it clear how to create a new branch? Does it update live or require manual refresh?
- **Stash Panel**: Is the active/archived distinction explained?
- **Config Panel**: After editing config, what should happen? Is there guidance about what changed or what to do next (e.g., run `wt sync`)?
- **Template Panel**: Are template variables documented inline?

### Shell Integration

- **Post-init**: Does the user know they need to source the shell wrapper?
- **Cursor visibility**: Is the cursor restored after TUI exit and after checkout?
- **Hooks**: Can hooks be edited from the TUI? Is the post-checkout hook discoverable?

---

## 1.2 Design Each Improvement

For every gap identified, write a concrete spec. Each spec must include:

1. **What the user sees now** (current behavior).
2. **What the user should see** (target behavior).
3. **Where the change lives** (which file(s) to modify).
4. **Exact wording** of any new messages, hints, or UI elements.

### Required Improvements

The following are known gaps that MUST be addressed. The audit may surface additional ones.

#### A. Init Feedback & Shell Guidance

**Current**: `wt init` completes silently. The user's shell is not navigated to the active slot (unless shell integration is sourced). No mention of shell integration.

**Target**: After init, print a summary:
```
wt: Initialized with 5 worktree slots.
wt: Active worktree: <slot-name> (branch: <branch>)
wt:
wt: To enable shell navigation (cd on checkout), add to your shell config:
wt:   eval "$(wt shell-init bash)"    # bash
wt:   eval "$(wt shell-init zsh)"     # zsh
wt:   wt shell-init fish | source     # fish
wt:
wt: Then restart your shell or run the eval command now.
```

If shell integration is NOT active (detected by absence of nav file mechanism or environment variable), always include the shell hint. If it IS active, omit it.

#### B. Branch Creation During Checkout

**Current**: `wt checkout <branch>` only checks out existing branches (local or remote). There is no way to create a new branch from the CLI or TUI.

**Target**:
- CLI: `wt checkout -b <new-branch> [start-point]` creates a new branch from `start-point` (default: current HEAD or `origin/<default-branch>`). Mirrors `git checkout -b`.
- TUI: Add a "Create Branch" action in the Worktree Panel (e.g., `n` key). Prompts for branch name, creates from `origin/<default-branch>`, and checks it out.

#### C. Checkout Feedback

**Current**: Checkout is silent on success. The user doesn't know if eviction occurred, if a stash was saved/restored, or if a new branch was created from remote.

**Target**: Print a brief summary after checkout:
```
wt: Checked out feature/my-branch in <slot-name>
wt: Evicted <old-branch> from <slot-name> (dirty state stashed)
wt: Restored stash from 2d ago
```

Only print lines that are relevant. Keep it terse — one line per significant action.

#### D. Cursor Visibility

**Current**: The cursor disappears after TUI exit or after checkout (likely an Ink cleanup issue).

**Target**: Ensure `process.stdout.write('\x1B[?25h')` (show cursor) is called on TUI exit and after any command that might hide it. This is a terminal escape sequence fix.

#### E. TUI Branch Completeness

**Current**: The Worktree Panel only shows branches known to `wt` (those checked out via `wt checkout`). Branches created via direct `git checkout -b` inside a slot are reconciled into state but may not appear in the TUI's inactive list.

**Target**: The Worktree Panel should show:
1. All branches currently in slots (active — already works).
2. All branches previously known to `wt` (inactive — already works).
3. All local branches in the repo (new section or merged into inactive list, dimmed).

The branch search (`/`) already shows all local+remote branches. The default list should also surface all local branches so the user doesn't have to search to find branches they just created.

#### F. TUI Live Updates

**Current**: The TUI is a static snapshot. If the user has another terminal making changes, the TUI doesn't reflect them until the user navigates away and back.

**Target**: Poll for state changes every 2 seconds. On each tick:
- Re-run reconciliation.
- Re-read slot status (dirty/clean).
- Update the display if anything changed.

Keep it lightweight — only re-read `state.toml` and run `git status --porcelain` per slot. Do NOT re-fetch.

#### G. Config Edit Guidance

**Current**: After editing config in the TUI, the user returns to the main menu with no feedback. Changes to `slot_count`, `shared.directories`, or `templates` may require `wt sync` to take effect.

**Target**: After the editor closes, compare the old and new config. If changes were detected, print guidance:
```
Config updated.
  slot_count: 5 → 7 (run any wt command to create new slots)
  shared.directories: added ".env.local.d" (run 'wt sync' to propagate)
  templates: added 1 template (run 'wt sync' to generate)
```

If no changes detected: "No changes."

#### H. Hook Editing from TUI

**Current**: Hooks (`.wt/hooks/post-checkout`) are not surfaced in the TUI. Users must know about them from documentation.

**Target**: Add a 5th item to the TUI Main Menu: **"Edit Hooks"**. This panel lists hook files in `.wt/hooks/`, allows editing them in `$EDITOR`, and shows a brief description of each hook's purpose. If no hooks exist, offer to create the `post-checkout` hook with a template.

#### I. Claude Code Hook for Worktree Pinning

**Current**: No integration with Claude Code. If Claude Code is running a prompt in a worktree, that worktree could be evicted by another `wt checkout`.

**Target**: Document (and optionally ship) a Claude Code hook that:
1. On prompt start: runs `wt pin` in the current worktree.
2. On prompt end: runs `wt unpin` in the current worktree.

This prevents eviction of worktrees actively being used by Claude Code. The hook configuration lives in Claude Code's settings, not in `wt` itself. Provide the hook definition in a new section of the README or as a `wt hooks show claude-code` output.

---

## 1.3 Update VISION.md

For each improvement that changes behavior described in the vision, draft the VISION.md amendment. Specifically:

- Section 2 (Initialization): Add post-init output spec.
- Section 3 (Branch Checkout): Add `-b` flag for branch creation. Add checkout feedback output.
- Section 4 (Shell Integration): Add shell hint on first init.
- Section 8 (TUI): Add live polling. Add hook editing panel. Add branch creation action. Add config change guidance.
- New section or appendix: Claude Code hook example.

---

## 1.4 Write the Phase 2 Spec

Once all improvements are designed, write the implementation checklist for Phase 2 (the implementation phase). Each item should be a single, testable unit of work.

---

## Completion Checklist

- [x] Every CLI command audited for UX gaps.
- [x] Every TUI panel audited for UX gaps.
- [x] Shell integration audited.
- [x] Concrete spec written for each improvement (A through I, plus any additional).
- [x] VISION.md amendments drafted and applied.
- [x] Phase 2 implementation checklist written.
- [x] All specs reviewed for consistency with existing VISION.md.
