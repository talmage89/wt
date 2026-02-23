# wt — Implementation Plan

## Project Structure

```
wt/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── .eslintrc.cjs
├── bin/
│   └── wt.mjs                  # Node entry point (thin shim)
├── src/
│   ├── cli.ts                   # CLI entry: parse args, route to commands
│   ├── commands/
│   │   ├── init.ts              # wt init [url]
│   │   ├── checkout.ts          # wt checkout <branch> (alias: co)
│   │   ├── fetch.ts             # wt fetch
│   │   ├── stash.ts             # wt stash list|apply|drop|show
│   │   ├── sync.ts              # wt sync
│   │   ├── clean.ts             # wt clean
│   │   ├── list.ts              # wt list (alias: ls)
│   │   ├── pin.ts               # wt pin / wt unpin
│   │   └── shell-init.ts        # wt shell-init <shell>
│   ├── core/
│   │   ├── container.ts         # Find/validate .wt container from cwd
│   │   ├── git.ts               # All git operations (thin wrappers, errors pass through)
│   │   ├── slots.ts             # Slot management: create, evict, assign, LRU
│   │   ├── state.ts             # Read/write .wt/state.toml (slot assignments, LRU, pins)
│   │   ├── config.ts            # Read/write .wt/config.toml
│   │   ├── stash.ts             # Stash create/apply/drop/archive/list
│   │   ├── symlinks.ts          # Shared symlink management
│   │   ├── templates.ts         # Template variable expansion and generation
│   │   ├── reconcile.ts         # Scan slots, update internal state to match reality
│   │   ├── branch-encode.ts     # Encode branch names for file paths / ref names
│   │   ├── nav.ts               # Write nav file for shell integration
│   │   └── words.ts             # Word list + random 3-word name generator
│   ├── tui/
│   │   ├── App.tsx              # Root Ink component
│   │   ├── MainMenu.tsx         # Top-level menu
│   │   ├── WorktreePanel.tsx    # Branch-centric worktree view
│   │   ├── StashPanel.tsx       # Stash management view
│   │   ├── ConfigPanel.tsx      # Config editor
│   │   ├── TemplatePanel.tsx    # Template editor
│   │   └── components/          # Shared TUI components (list, status dot, etc.)
│   ├── shell/
│   │   ├── bash.sh              # Shell function for bash
│   │   ├── zsh.sh               # Shell function for zsh
│   │   └── fish.fish            # Shell function for fish
│   └── data/
│       └── words.ts             # Curated word list (~300-500 words)
├── test/
│   ├── unit/
│   │   ├── branch-encode.test.ts
│   │   ├── words.test.ts
│   │   ├── config.test.ts
│   │   ├── state.test.ts
│   │   ├── templates.test.ts
│   │   ├── slots.test.ts
│   │   └── nav.test.ts
│   ├── integration/
│   │   ├── helpers.ts           # Test scaffolding (create temp git repos)
│   │   ├── init.test.ts
│   │   ├── checkout.test.ts
│   │   ├── stash.test.ts
│   │   ├── symlinks.test.ts
│   │   ├── reconcile.test.ts
│   │   └── pin.test.ts
│   └── fixtures/                # Sample repos, config files, etc.
└── wordlist/
    └── generate.ts              # Script to curate/filter the word list
```

## Dependencies

| Package | Purpose |
|---|---|
| `yargs` | CLI argument parsing and command routing |
| `@iarna/toml` / `smol-toml` | TOML parse/serialize for config and state |
| `ink` + `react` | TUI framework |
| `ink-text-input` | TUI text input component |
| `ink-select-input` | TUI list selection |
| `zstd-codec` or call `zstd` binary | Stash archive compression |
| `vitest` | Test runner |
| `tsx` | Dev-time TypeScript execution |
| `tsup` | Build/bundle |
| `execa` | Subprocess execution for git commands (typed, promise-based) |

## Module Responsibilities

### `core/git.ts`
Thin wrappers around git commands. Every function calls `execa('git', [...args])` in a given working directory. **Never** catches or wraps git stderr — pipe it through to the user. Key functions:
- `fetch(repoDir)` — centralized fetch
- `worktreeAdd(repoDir, path, opts)` — create worktree
- `checkout(worktreeDir, branch)` — checkout branch in worktree
- `checkoutDetach(worktreeDir)` — detach HEAD
- `stashCreate(worktreeDir)` — `git stash create -u`
- `stashApply(worktreeDir, ref)` — `git stash apply <ref>`
- `updateRef(repoDir, refName, hash)` / `deleteRef(repoDir, refName)`
- `status(worktreeDir)` — `git status --porcelain`
- `lsRemoteHeads(repoDir, branch)` — check if branch exists on remote
- `currentBranch(worktreeDir)` — get checked-out branch (or null if detached)
- `defaultBranch(repoDir)` — detect remote default branch

### `core/container.ts`
- `findContainer(startDir)` — Walk up from cwd to find a directory containing `.wt/`. Returns paths for container, `.wt/`, and repo.
- `isInsideWorktree(startDir)` — Determine if cwd is inside a managed worktree slot.
- `createContainer(dir)` — Create `.wt/` and subdirectories.

### `core/state.ts`
- `readState(wtDir)` → `State` object
- `writeState(wtDir, state)`
- State shape: `{ slots: { [name]: { branch, lastUsedAt, pinned } } }`

### `core/config.ts`
- `readConfig(wtDir)` → `Config` object
- `writeConfig(wtDir, config)`
- Config shape mirrors `.wt/config.toml` schema

### `core/slots.ts`
- `createSlots(repoDir, containerDir, count, defaultBranch)` — initial slot creation
- `findSlotForBranch(state, branch)` — is this branch already in a slot?
- `selectSlotForCheckout(state)` — vacant → LRU unpinned → error if all pinned
- `evictSlot(wtDir, slot, state)` — stash dirty state, detach HEAD
- `markSlotUsed(state, slotName, branch)` — update LRU timestamp

### `core/stash.ts`
- `saveStash(wtDir, repoDir, branch, worktreeDir)` — create stash + ref + metadata
- `restoreStash(wtDir, repoDir, branch, worktreeDir)` → success | conflict | no-stash
- `listStashes(wtDir)` → array of stash metadata
- `dropStash(wtDir, repoDir, branch)` — delete ref + metadata
- `showStash(repoDir, branch, stashRef)` — `git stash show -p`
- `archiveScan(wtDir, repoDir)` — check remote, archive old stashes
- `archiveStash(wtDir, repoDir, branch)` — export patch, compress with zstd, delete ref

### `core/branch-encode.ts`
- `encodeBranch(name)` — `/` → `--`, invalid chars → percent-encoded
- `decodeBranch(encoded)` — reverse

### `core/reconcile.ts`
- `reconcile(wtDir, containerDir, state)` → updated `State`
- Scans each slot's actual git state, updates branch assignments, detects direct checkouts

### `core/symlinks.ts`
- `establishSymlinks(wtDir, worktreeDir, sharedDirs, branch)`
- `syncAllSymlinks(wtDir, containerDir, state, sharedDirs)`
- `isGitTracked(worktreeDir, filePath)` — check if file is tracked (skip symlink if so)

### `core/templates.ts`
- `generateTemplates(wtDir, worktreeDir, slotName, branch, templates)`
- `generateAllTemplates(wtDir, containerDir, state, templates)`
- Variable expansion: `{{WORKTREE_DIR}}` → slotName, `{{BRANCH_NAME}}` → branch

### `core/nav.ts`
- `writeNavFile(targetDir)` → path to temp file
- `readNavFile(path)` → target dir
- `cleanNavFile(path)`

### `core/words.ts`
- `generateSlotName(existingNames)` → unique 3-word hyphenated name
- Uses curated word list from `data/words.ts`

---

## Implementation Phases

### Phase 1: Project Scaffolding & Core Utilities
**Goal**: Buildable project, pure-logic modules with tests.

1. `pnpm init`, install deps, configure `tsconfig.json`, `vitest`, `tsup`
2. Implement `core/branch-encode.ts` + tests
3. Implement `core/words.ts` + curate word list in `data/words.ts` + tests
4. Implement `core/config.ts` (TOML read/write) + tests
5. Implement `core/state.ts` (TOML read/write) + tests
6. Implement `core/nav.ts` + tests
7. Implement `core/templates.ts` (pure string expansion, file writing) + tests
8. Implement `core/git.ts` — thin execa wrappers, no logic to unit-test (tested via integration)

**Deliverable**: All pure-logic modules working with unit tests passing.

---

### Phase 2: Container & Slot Management
**Goal**: `wt init` works end-to-end.

1. Implement `core/container.ts` — find/create container
2. Implement `core/slots.ts` — create slots, LRU selection, eviction logic
3. Implement `commands/init.ts`:
   - From existing repo: move repo → `.wt/repo/`, detect default branch, create slots, checkout starting branch in one slot, generate templates, establish symlinks
   - From URL: bare clone → `.wt/repo/`, same as above
4. Implement `commands/shell-init.ts` — output shell functions for bash/zsh/fish
5. Write shell scripts in `src/shell/` (bash.sh, zsh.sh, fish.fish)
6. Wire up CLI entry point (`src/cli.ts`) with yargs, register `init` and `shell-init` commands
7. Create `bin/wt.mjs` entry shim
8. Integration tests: init from existing repo, init from URL, verify directory layout

**Deliverable**: `wt init` creates a fully structured container. `wt shell-init bash` outputs a working shell function.

---

### Phase 3: Checkout & Stash Lifecycle
**Goal**: `wt checkout <branch>` works with stash save/restore.

1. Implement `core/stash.ts` — save, restore, list, drop, show
2. Implement `core/reconcile.ts` — scan slots, update state
3. Implement `commands/checkout.ts`:
   - Centralized fetch
   - Archive scan
   - Find existing slot or select via LRU
   - Evict (stash + detach) if needed
   - Checkout branch
   - Restore stash (unless `--no-restore`)
   - Regenerate templates
   - Reconcile symlinks
   - Write nav file
4. Wire `checkout` / `co` into CLI
5. Integration tests: checkout new branch, checkout existing branch (navigate), eviction with stash, stash restore, `--no-restore`, checkout with all slots pinned (error)

**Deliverable**: Full checkout flow including stash save/restore, slot eviction, and shell navigation.

---

### Phase 4: Symlinks & Templates (Full)
**Goal**: `wt sync` works. Shared symlinks and template generation are complete.

1. Implement `core/symlinks.ts` — full sync logic (move real files to shared, create symlinks, handle git-tracked conflicts, clean broken symlinks)
2. Implement `commands/sync.ts` — propagate symlinks + regenerate templates across all slots
3. Integration tests: sync creates symlinks, git-tracked file skipped, broken symlink cleaned, template regeneration

**Deliverable**: `wt sync` fully operational.

---

### Phase 5: Remaining CLI Commands
**Goal**: All CLI commands implemented.

1. `commands/fetch.ts` — centralized fetch + archive scan
2. `commands/stash.ts` — subcommands: list, apply, drop, show
3. `commands/list.ts` — display all slots with branch, status, pin, last-used
4. `commands/pin.ts` — pin/unpin current or named slot
5. `commands/clean.ts` — interactive archive review + deletion
6. Integration tests for each command

**Deliverable**: Complete CLI surface. All commands from Section 9 of the vision work.

---

### Phase 6: Stash Archival
**Goal**: Archive lifecycle (active → archived → deleted) fully works.

1. Implement `archiveStash` in `core/stash.ts` — export patch, compress with zstd, delete git ref, update metadata
2. Implement archive scan logic fully (check remote, check age, trigger archival)
3. Implement `wt clean` interactive flow (list archived, select for deletion)
4. Integration tests: stash ages, gets archived, can be deleted

**Deliverable**: Full stash lifecycle per Section 5.3 of the vision.

---

### Phase 7: TUI
**Goal**: `wt` (no args) opens a fullscreen TUI.

1. Set up Ink rendering in `src/tui/App.tsx`
2. `MainMenu.tsx` — 4-item menu (Manage Worktrees, Manage Stashes, Edit Config, Edit Templates)
3. `WorktreePanel.tsx`:
   - Branch-centric list (pinned → active → inactive)
   - Status dots (green/yellow)
   - Metadata (slot name, time since last used, stash indicator)
   - Actions: checkout, pin/unpin, view status
   - Branch search (fuzzy, all local+remote branches)
4. `StashPanel.tsx`:
   - Grouped by status (active, archived)
   - Actions: apply, view diff, delete, bulk delete
5. `ConfigPanel.tsx` — in-terminal editor for config.toml
6. `TemplatePanel.tsx` — list templates, edit source, prompt regeneration
7. Wire TUI launch into CLI (no args → TUI if inside container, else help)

**Deliverable**: Full TUI per Section 8 of the vision.

---

### Phase 8: Polish & Edge Cases
**Goal**: Production-ready.

1. Slot count changes (increase: create new slots; decrease: evict excess, error if pinned > new count)
2. Thorough error handling for all Section 15 scenarios
3. Reconciliation hardening (detect moved/deleted worktrees, handle corruption)
4. Performance: parallel git status checks across slots
5. End-to-end tests simulating real user workflows
6. `README.md`, `--help` text for all commands
7. npm `bin` field, `package.json` `files` field, verify `npx wt` works

---

## Testing Strategy

- **Unit tests** (vitest): Pure logic modules — branch encoding, word generation, config/state parsing, template expansion, slot selection algorithm, nav file I/O.
- **Integration tests** (vitest): Create real temporary git repos, run actual git commands, verify full flows (init, checkout, stash, symlinks). Use `tmp` directories cleaned up after each test.
- **No mocking of git**: Integration tests use real git operations. This catches real-world edge cases. Only mock the filesystem for unit tests where needed.
- **Test naming**: `describe('command name')` → `it('should ...')` — behavior-driven.

## Key Design Decisions

1. **`execa` for git**: Typed, promise-based, inherits stderr for pass-through errors. Use `{cwd, stdio: ['pipe','pipe','inherit']}` so git errors go straight to the terminal.
2. **TOML via `smol-toml`**: Lightweight, modern, good TypeScript types. Alternative: `@iarna/toml`.
3. **yargs for CLI**: Mature, supports subcommands, aliases, completions. Lighter than oclif.
4. **No ORM/class hierarchy for state**: Simple read/write functions operating on plain objects. State files are small TOML; no need for a database.
5. **Reconcile on every command**: First thing every command does is call `reconcile()`. This keeps internal state in sync with reality without the user needing to think about it.
6. **Nav file for shell integration**: Write target dir to `/tmp/wt-nav-<pid>`, shell function reads it and `cd`s. Simple, no IPC needed.
7. **Word list**: ~300-500 curated adjective/noun words. 3-word combinations give ~27M+ unique names — more than enough. Filter for length (3-7 chars), memorability, and inoffensiveness.
