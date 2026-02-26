# Phase 1: Usage-Testing Polish

**Goal**: Address UX friction and bugs discovered during continuous usage testing.

**Depends on**: All core implementation and UX improvements complete. All automated tests passing.

---

## Implementation Items

Each item is a self-contained unit of work. Items are ordered by dependency — earlier items do not depend on later ones.

---

### 1.1 Fix Double Keystroke in Config Panel

**Files**: `src/tui/ConfigPanel.tsx`

When editing the configuration file through the TUI, every key press registers twice. The `useInput` handler (line 85) fires unconditionally on every keystroke regardless of phase, and likely conflicts with the editor subprocess or Ink's input handling during the `"editing"` phase.

**Fix**: Guard `useInput` to only handle input during the `"summary"` phase, or disable Ink's raw mode while the external editor is active.

**Test**: Open TUI, navigate to Config, edit the file, verify each key registers exactly once.

---

### 1.2 Add Template Examples to Config File

**Files**: `src/commands/init.ts` (initial config generation), `src/core/config.ts`

The Templates panel says "edit config to add templates" but the config file contains no examples, leaving the user with no guidance on the syntax.

**Fix**: When generating the initial `.wt/config.toml`, include a commented-out `[[templates]]` example block:

```toml
# [[templates]]
# source = ".env.template"
# target = ".env"
# Variables: {{WORKTREE_DIR}}, {{BRANCH_NAME}}
```

**Test**: `wt init` produces a config file with the commented template example. Existing configs are not modified.

---

### 1.3 Worktree Menu: LRU Order with Pinned-in-Place

**Files**: `src/tui/WorktreePanel.tsx` (sort logic, lines 102–107)

Currently the worktree menu sorts pinned entries first, then active, then inactive. This is disruptive — the list order should be stable and predictable.

**Current sort** (line 102):
```
pinned: 0, active: 1, inactive: 2
```

**Target sort**: All entries sorted by LRU recency (most recently used first). Pinned entries stay in their natural LRU position — they are not promoted to the top. The pin indicator is sufficient to convey pinned status.

**Test**: Pin a worktree that was used a while ago, verify it stays in its LRU position rather than jumping to the top.

---

### 1.4 Worktree Menu: Optimistic UI (No Loading State)

**Files**: `src/tui/WorktreePanel.tsx` (lines 119, 396–401)

The worktree menu shows a "Loading..." message on initial render. This is disruptive — the menu should render immediately with cached/last-known state and update in the background.

**Fix**:
- On first render, read `state.toml` synchronously (or cache from the previous poll cycle) and render the menu immediately.
- Run git status checks and reconciliation in the background; update entries as results arrive.
- Never show a blank "Loading..." screen for the worktree list.

**Test**: Open TUI, verify the worktree menu appears instantly without a loading flash.

---

### 1.5 Pre-validate `wt checkout -b` Before Eviction

**Files**: `src/commands/checkout.ts` (lines 130–147, 182–191)

The BUG-028 fix added pre-validation for regular checkout, but the `-b` (create) path still evicts before attempting `git checkout -b`. If the branch already exists or the start point is invalid, the slot is left vacant.

**Fix**: Before eviction (step 8), when `options.create` is true:
1. Check if the branch already exists locally (`refs/heads/<branch>`). If so, fail with `"Branch '<branch>' already exists."`.
2. If a `startPoint` is provided, verify it resolves (`git rev-parse --verify <startPoint>`). If not, fail with the git error.

**Test**: `wt checkout -b existing-branch` fails without evicting. `wt checkout -b new-branch bad-start-point` fails without evicting.

---

### 1.6 Fetch Cooldown

**Files**: `src/core/git.ts`, `src/core/config.ts`, `src/commands/checkout.ts`, `src/commands/fetch.ts`

The tool feels slow, likely because `git fetch` runs on every checkout and many other operations. Fetches should have a cooldown.

**Fix**:
- Record the last fetch timestamp in `.wt/state.toml` (e.g., `last_fetch_at`).
- Before fetching, check if the cooldown has elapsed (default: 10 minutes, configurable via `fetch_cooldown_minutes` in config).
- Skip the fetch if within cooldown. `wt fetch` (explicit) always fetches regardless of cooldown.
- Print `wt: Skipping fetch (last fetched <N>m ago)` when skipped (only if verbose or debug, otherwise silent).

**Test**: Run `wt checkout` twice within 10 minutes — second run skips fetch. `wt fetch` always runs. Changing `fetch_cooldown_minutes` in config is respected.

---

### 1.7 Stash Tag Layout: Move `[stash]` After Relative Time

**Files**: `src/tui/WorktreePanel.tsx` (lines 524–531)

Currently the display order is: `branch  slot  [stash]  31s ago`. The `[stash]` tag visually pushes the time away from the branch name, making it harder to scan recency at a glance.

**Target**: `branch  slot  31s ago  [stash]`

**Fix**: Swap the render order of the `[stash]` tag and the `RelativeTime` component.

**Test**: Entry with a stash shows time before `[stash]` tag.

---

### 1.8 Config Panel: Immediate Slot Adjustment After `slot_count` Change

**Files**: `src/tui/ConfigPanel.tsx`, `src/core/slots.ts`

After editing the config and changing `slot_count`, the summary currently says "new slots will be created/evicted on next wt command". The user has to leave the TUI and run a command before the change takes effect.

**Fix**: When a `slot_count` change is detected in the summary phase, show a prompt: `"Apply now? (y/n)"`.
- If **yes**: call `adjustSlotCount()` (the same logic that runs on the next `wt` command) immediately, then display what happened (e.g., "Created 2 new slots: amber-fox-glen, crisp-oak-vale" or "Evicted 1 slot: dusk-fern-mist (dirty state stashed)").
- If **no** (or any other key): show the existing guidance text and return to the menu.

This keeps the current deferred behavior as the default but gives the user a fast path.

**Test**: Change `slot_count` from 5 to 7 in the TUI config editor, press `y` at the prompt, verify 2 new slots are created immediately. Change from 7 to 5, press `y`, verify LRU eviction of 2 slots.

---

### 1.9 Resume Command (`wt -`)

**Files**: `src/cli.ts`, `src/commands/checkout.ts`, `src/core/state.ts`, `src/core/nav.ts`

After switching between projects or terminals, there's no quick way to get back to the worktree you were last working in. `cd`-ing manually requires remembering the slot name.

**Fix**: `wt -` (or `wt resume`) navigates to the most recently used worktree slot:
1. Read `state.toml`, find the slot with the most recent `last_used_at`.
2. Write the nav file pointing to that slot's directory.
3. The shell function handles the `cd`.

If the MRU slot is the current directory, this is a no-op. If all slots are vacant, print an error.

This mirrors `cd -` and `git checkout -` conventions — a single character to go back to where you were.

**Test**: Check out branch A, then branch B (in a different terminal or after navigating away). Run `wt -`, verify cwd changes to the slot containing branch B (the MRU). Run from outside any worktree, verify it navigates to the MRU slot.

---

## Completion Checklist

- [x] Config panel registers single keystrokes during editing.
- [x] Initial config file includes commented template examples.
- [x] Worktree menu renders in LRU order; pinned entries are not promoted.
- [ ] Worktree menu renders instantly without "Loading..." flash.
- [ ] `wt checkout -b` validates before evicting.
- [ ] Fetch cooldown prevents redundant fetches (default 10 min).
- [ ] Stash tag appears after relative time in worktree list.
- [ ] Config panel offers immediate slot adjustment after `slot_count` change.
- [ ] `wt -` navigates to the most recently used worktree.
- [ ] All existing tests still pass (`pnpm test`).
- [ ] No type errors (`pnpm tsc --noEmit`).
- [ ] `pnpm build` succeeds and binary reflects all changes.
