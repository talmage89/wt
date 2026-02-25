# Phase 2: UX Improvement Implementation

**Goal**: Implement all UX improvements specified in Phase 1.

**Depends on**: Phase 1 (all specs finalized, VISION.md updated).

---

## Implementation Items

Each item is a self-contained unit of work. An agent should complete one item per session, commit, and exit. Items are ordered by dependency — earlier items do not depend on later ones.

---

### 2.1 Cursor Visibility Fix

**Files**: `src/tui/App.tsx`, `src/cli.ts`

Ensure the terminal cursor is restored after:
- TUI exit (normal quit, error, Ctrl-C).
- Any CLI command that uses Ink or raw mode.

Write `\x1B[?25h` to stdout on process exit. Add a `process.on('exit', ...)` handler and an Ink cleanup hook.

**Test**: Launch TUI, quit, verify cursor is visible. Run `wt checkout`, verify cursor is visible.

---

### 2.2 Init Feedback & Shell Guidance

**Files**: `src/commands/init.ts`, `src/commands/shell-init.ts`

After successful init, print a summary to stderr:
- Number of slots created and their names.
- Which slot has the active branch.
- Shell integration instructions (if shell wrapper is not active).

Detection of shell wrapper: check for an environment variable set by the shell function (e.g., `WT_SHELL_INTEGRATION=1`), or simply always print the hint on first init.

Update shell scripts (`src/shell/bash.sh`, `src/shell/zsh.sh`, `src/shell/fish.fish`) to export `WT_SHELL_INTEGRATION=1` so the CLI can detect it.

**Test**: `wt init <url>` prints slot summary and shell hint. After sourcing shell-init, `wt init` in a new container omits the shell hint.

---

### 2.3 Checkout Feedback

**Files**: `src/commands/checkout.ts`

After checkout completes, print a summary to stderr:
- `Checked out <branch> in <slot-name>`
- `Evicted <old-branch> from <slot-name> (dirty state stashed)` (if eviction occurred)
- `Restored stash from <relative-time>` (if stash was restored)
- `Created local branch <branch> from origin/<branch>` (if branch was newly created from remote)
- `Navigating to <slot-path>` (if shell integration is active)

Each line prefixed with `wt: `. Only print lines that apply.

**Test**: Checkout triggers appropriate messages. Checkout to existing slot prints only the checkout line.

---

### 2.4 Branch Creation (`-b` flag)

**Files**: `src/cli.ts`, `src/commands/checkout.ts`, `src/core/git.ts`

Add `-b` flag to `wt checkout`:
- `wt checkout -b <new-branch>` creates from `origin/<default-branch>`.
- `wt checkout -b <new-branch> <start-point>` creates from `<start-point>`.

Implementation: select a slot (same eviction logic), then `git checkout -b <branch> <start-point>` instead of `git checkout <branch>`.

**Test**: `wt checkout -b feature/new` creates branch and checks it out. `wt checkout -b feature/new origin/develop` creates from specified start point.

---

### 2.5 TUI Branch Completeness

**Files**: `src/tui/WorktreePanel.tsx`, `src/core/git.ts`

Add a function to list all local branches: `git branch --format='%(refname:short)'`.

In the Worktree Panel, merge local branches into the display:
- Active branches (in slots): shown as before.
- Inactive branches (previously known to `wt` + all local branches not in slots): shown dimmed.
- Deduplicate: if a branch is both in `wt` history and in `git branch`, show it once.

**Test**: Create branches via `git checkout -b` directly, verify they appear in the TUI.

---

### 2.6 TUI Branch Creation

**Files**: `src/tui/WorktreePanel.tsx`

Add `n` keybinding in the Worktree Panel to create a new branch:
1. Prompt for branch name (text input).
2. Create from `origin/<default-branch>` (or allow user to type a start point).
3. Check out the new branch (triggers slot selection / eviction).
4. Navigate to the slot.

**Test**: Press `n`, type branch name, verify branch is created and checked out.

---

### 2.7 TUI Live Polling

**Files**: `src/tui/App.tsx`, `src/tui/WorktreePanel.tsx`, `src/tui/StashPanel.tsx`

Add a polling mechanism:
- Every 2 seconds, re-read state and re-run lightweight status checks.
- Use `setInterval` in a `useEffect` hook.
- Only update React state if something changed (avoid unnecessary re-renders).
- Polling is active only when the TUI is in the foreground (not while `$EDITOR` is open).

**Test**: Open TUI, make a change in another terminal (e.g., create a file), verify TUI updates within ~2 seconds.

---

### 2.8 Config Edit Guidance

**Files**: `src/tui/ConfigPanel.tsx`, `src/core/config.ts`

After the editor closes:
1. Re-read config.
2. Compare with the config snapshot taken before the editor opened.
3. Display a diff summary showing what changed and what action is needed.
4. If `slot_count` changed: mention that new slots will be created/evicted on next command.
5. If `shared.directories` changed: suggest `wt sync`.
6. If `templates` changed: suggest `wt sync`.
7. If no changes: show "No changes."

**Test**: Edit config to add a shared directory, verify guidance message appears.

---

### 2.9 Hook Editing from TUI

**Files**: `src/tui/App.tsx`, `src/tui/MainMenu.tsx`, new file `src/tui/HooksPanel.tsx`

Add "Edit Hooks" as the 5th main menu item.

The Hooks Panel:
- Lists files in `.wt/hooks/` (or shows "No hooks configured").
- Selecting a hook opens it in `$EDITOR`.
- If no `post-checkout` hook exists, offer to create one with a commented template explaining the arguments (`$1` = worktree path, `$2` = branch name).
- After editing, show the hook's executable status. If not executable, offer to `chmod +x`.

**Test**: Open TUI, navigate to Edit Hooks, create a post-checkout hook, verify it's executable and runs on next checkout.

---

### 2.10 Claude Code Worktree Pin Hook

**Files**: Documentation only (or a new `src/commands/hooks.ts` if adding a `wt hooks` subcommand).

Provide a Claude Code hook configuration that:
- On `PreToolUse` (or session start): runs `wt pin` in the current worktree.
- On session end (or `PostToolUse`): runs `wt unpin`.

This can be:
- A section in the README.
- Output from `wt hooks show claude-code` (new subcommand).
- A `.claude/hooks.json` template in `.wt/shared/`.

At minimum, document the hook. Optionally implement `wt hooks show <integration>` to emit the configuration.

**Test**: Manual verification — configure the hook, start a Claude Code session, verify worktree is pinned, end session, verify unpinned.

---

## Completion Checklist

- [x] Cursor always visible after TUI exit and CLI commands.
- [x] `wt init` prints slot summary and shell integration hint.
- [x] `wt checkout` prints action summary (eviction, stash, branch creation).
- [x] `wt checkout -b <branch>` creates new branches.
- [x] TUI Worktree Panel shows all local branches.
- [x] TUI supports creating new branches via `n` key.
- [x] TUI polls for state changes every 2 seconds.
- [x] Config Panel shows change guidance after editing.
- [x] Hooks Panel exists in TUI with create/edit/chmod flow.
- [ ] Claude Code pin hook documented or implemented.
- [ ] All existing tests still pass (`pnpm test`).
- [ ] No type errors (`pnpm tsc --noEmit`).
- [ ] `pnpm build` succeeds and binary reflects all changes.
