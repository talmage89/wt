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

## Current Phases

Core implementation and UX improvements (the original Phases 1–8 plus UX audit/implementation) are complete. The project now has two active phases:

- **Phase 1: Usage-Testing Polish** — UX friction and bugs surfaced during usage testing (double keystrokes in config, template examples, LRU ordering, optimistic UI, `-b` pre-validation, fetch cooldown, stash tag layout, immediate slot adjustment, `wt -` resume command). See `.docs/PHASE-1.md`.
- **Phase 2: Continuous Usage Testing** — The endless testing loop. Fix open bugs or run manual usage test cycles against the real binary. See `.docs/PHASE-2.md`.

## Testing Strategy

- **Unit tests** (vitest): Pure logic modules — branch encoding, word generation, config/state parsing, template expansion, slot selection algorithm, nav file I/O.
- **Integration tests** (vitest): Create real temporary git repos, run actual git commands, verify full flows (init, checkout, stash, symlinks). Use `tmp` directories cleaned up after each test.
- **Usage tests** (Phase 3): Manual testing against the real built binary, exercising edge cases and adversarial scenarios not covered by automated tests.
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
