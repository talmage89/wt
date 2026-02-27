# wt

A CLI and TUI for managing git worktrees via a fixed pool of reusable slots.

## Why

Worktrees are expensive to create and tear down. Dependency installs, build caches, generated files, dev-server state — all of it resets when you create a fresh worktree and gets left behind when you remove one.

`wt` takes a different approach: maintain a stable pool of worktree directories and reuse them. When you switch branches, `wt` saves your dirty state, evicts the least recently used slot, checks out the new branch, and restores any previously saved state — all in one command.

## Quick start

```sh
# From an existing repo
cd my-project
wt init

# Or clone directly
mkdir my-project && cd my-project
wt init https://github.com/org/repo.git
```

Set up shell integration (one-time):

```sh
# bash (~/.bashrc)
eval "$(wt shell-init bash)"

# zsh (~/.zshrc)
eval "$(wt shell-init zsh)"

# fish (~/.config/fish/config.fish)
wt shell-init fish | source
```

This wraps the `wt` binary in a shell function so it can `cd` you into worktrees.

Start working:

```sh
wt co feature/login     # check out a branch
wt co -b feature/signup # create and check out a new branch
wt -                    # jump back to the previous worktree
```

## How it works

After `wt init`, your project looks like this:

```
my-project/
  .wt/                        # metadata, config, stashes
    repo/                      # bare clone of the original repository
    config.toml
  a3f2/                        # worktree slot 1 (checked out to main)
  k7mz/                        # worktree slot 2 (vacant)
  p4qx/                        # worktree slot 3 (vacant)
  r9bn/                        # worktree slot 4 (vacant)
  w2jd/                        # worktree slot 5 (vacant)
```

Key ideas:

- **Slots** are permanent directories with random 4-character alphanumeric IDs. They are reused, never torn down.
- **LRU eviction** — when all slots are occupied, the least recently used one is freed up for the new branch.
- **Auto-stashing** — dirty state (staged, unstaged, untracked) is saved on eviction and restored on checkout.
- **Pinning** — pin a slot to protect it from eviction.
- **Shared fetch** — all slots share one git object store. `git fetch` runs once for all of them.

## Daily usage

### Checking out branches

```sh
wt checkout feature/login       # switch to a branch (alias: wt co)
wt co -b feature/signup         # create a new branch and switch to it
wt co -b feature/signup v2.0    # create from a specific start point
wt co --no-restore my-branch    # skip auto-restoring stashed state
wt -                            # resume the most recently used worktree
```

What happens on checkout:

1. Centralized `git fetch` (skipped if fetched within the last 10 minutes).
2. If the branch is already in a slot, navigate there.
3. Otherwise, pick a vacant slot or evict the LRU non-pinned slot.
4. Save dirty state from the evicted slot as a stash.
5. Check out the branch, restore any saved stash, regenerate templates, reconcile symlinks.
6. `cd` into the slot.

### Listing slots

```sh
wt list   # alias: wt ls
```

Shows all slots with their branch, dirty/clean status, pin state, and last-used time.

### Pinning

```sh
wt pin          # pin the current slot
wt unpin        # unpin it
wt pin <slot>   # pin a specific slot by name
```

Pinned slots are never evicted. If all slots are pinned and none are vacant, checkout will fail with an error.

## Stashes

Stashing is automatic — state is saved on eviction and restored on checkout. For manual control:

```sh
wt stash list               # see all saved stashes
wt stash show feature/login # view the diff
wt stash apply [branch]     # apply a stash manually
wt stash drop feature/login # delete a stash
```

### Archival

Stashes are archived when both conditions are met:
- The remote branch has been deleted.
- The stash hasn't been used by `wt` for 7 days (configurable).

Archived stashes are compressed with zstd. Review and delete them interactively:

```sh
wt clean
```

## Shared files

Symlink gitignored directories across all worktrees so edits in one slot appear in every other:

```toml
# .wt/config.toml
[shared]
directories = [".claude", ".env.local.d"]
```

One canonical copy lives in `.wt/shared/`. Each slot gets a symlink. If a file is tracked by git in a particular branch, git wins — no symlink is created.

Run `wt sync` to propagate changes after editing the config.

## Templates

Generate per-worktree files with variable substitution:

```toml
# .wt/config.toml
[[templates]]
source = "templates/.env.development"
target = ".env.development"
```

Available variables: `{{WORKTREE_DIR}}` (slot name) and `{{BRANCH_NAME}}` (current branch).

Example template (`.wt/templates/.env.development`):

```
DATABASE_URL=postgres://localhost:5432/myapp_{{WORKTREE_DIR}}
REDIS_PREFIX={{WORKTREE_DIR}}
BRANCH={{BRANCH_NAME}}
```

Templates regenerate on `wt init`, `wt checkout`, and `wt sync`.

## TUI

Run `wt` with no arguments inside a managed container to open the interactive TUI.

Panels:

- **Manage Worktrees** — browse all branches sorted by recency. Check out, pin/unpin, view status, or create new branches (`n` key). Pinned branches appear at the top. Green dot = clean, yellow = dirty.
- **Manage Stashes** — view, apply, or delete stashes. Bulk-delete archived stashes.
- **Edit Configuration** — opens `.wt/config.toml` in `$EDITOR`. Shows a diff summary on save.
- **Edit Templates** — list and edit template source files. Regenerate across all slots on save.
- **Edit Hooks** — manage `.wt/hooks/` scripts. Create, edit, toggle executable bit, or delete.

The TUI polls every 2 seconds and reconciles automatically if you make changes outside of `wt`.

## Hooks

### Post-checkout

Create `.wt/hooks/post-checkout` (must be executable):

```sh
#!/usr/bin/env bash
WORKTREE_PATH="$1"   # absolute path to the worktree
BRANCH="$2"          # branch name checked out
# your custom logic here
```

Runs after every `wt checkout`.

### Claude Code integration

Auto-pin the worktree while Claude Code is running so it isn't evicted mid-session. Run `wt hooks show claude-code` for the JSON to add to `.claude/settings.json`.

## Configuration reference

```toml
# .wt/config.toml

slot_count = 5                  # number of worktree slots
archive_after_days = 7          # days before archiving unused stashes
fetch_cooldown_minutes = 10     # skip fetch if done within this window

[shared]
directories = [".claude"]       # gitignored dirs to symlink across slots

[[templates]]
source = "templates/.env.development"
target = ".env.development"
```

Changing `slot_count`:
- **Increasing** — new vacant slots are created immediately.
- **Decreasing** — LRU slots are evicted. Fails if the number of pinned slots exceeds the new count.

## CLI reference

| Command | Description |
|---|---|
| `wt init [url]` | Initialize a container. Clone from `url` or restructure the current repo. |
| `wt checkout <branch>` | Switch to a branch (alias: `wt co`). `-b` to create. `--no-restore` to skip stash restore. |
| `wt -` | Resume the most recently used worktree (alias: `wt resume`). |
| `wt list` | Show all slots with branch, status, pin state, and last-used time (alias: `wt ls`). |
| `wt fetch` | Centralized fetch and archive scan. |
| `wt sync` | Propagate shared symlinks and regenerate templates across all slots. |
| `wt pin [slot]` | Pin a slot to prevent LRU eviction. Defaults to the current slot. |
| `wt unpin [slot]` | Unpin a slot. Defaults to the current slot. |
| `wt stash list` | List all saved stashes. |
| `wt stash show [branch]` | View the diff of a saved stash. |
| `wt stash apply [branch]` | Apply a stash. Deleted on clean apply, retained on conflict. |
| `wt stash drop [branch]` | Delete a stash without applying. |
| `wt clean` | Interactively review and delete archived stashes. |
| `wt shell-init <shell>` | Print shell integration code (`bash`, `zsh`, `fish`). |
| `wt hooks show claude-code` | Output Claude Code hook configuration JSON. |
| `wt` | Open the TUI (inside a container) or show help (outside). |

## Installation

### Prerequisites

- Node.js >= 20
- git
- zstd (for stash archival compression)

### From source

```sh
git clone https://github.com/talmage89/wt.git
cd wt
pnpm install
pnpm build
pnpm link --global
```

### Shell integration

Add one of the following to your shell config (see [Quick start](#quick-start)).

## Development

```sh
pnpm install       # install dependencies
pnpm dev           # run the CLI via tsx (no build step)
pnpm build         # build with tsup
pnpm test          # run tests with vitest
pnpm test:watch    # run tests in watch mode
```

### Project structure

```
src/
  cli.ts             # entry point and argument parsing (yargs)
  commands/          # one file per CLI command
  core/              # domain logic (git, stash, config, slots, symlinks, templates, etc.)
  data/              # static data (word list for slot names)
  tui/               # Ink (React) components for the TUI
test/                # vitest tests
.docs/VISION.md      # full design document
```

### Stack

- **TypeScript** on **Node.js**
- **pnpm** for package management
- **Ink** (React for CLI) for the TUI
- **yargs** for argument parsing
- **TOML** for configuration
- **vitest** for testing, **tsup** for building

## License

MIT
