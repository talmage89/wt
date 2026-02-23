# wt

An opinionated CLI and TUI for managing git worktrees via a fixed pool of reusable slots.

## Why

Worktrees are expensive to create and tear down in large repositories. Dependency installs, build caches, generated files, dev-server state — all of it resets every time you create a fresh worktree and gets left behind every time you remove one.

`wt` takes a different approach: maintain a stable pool of worktree directories and reuse them. When you switch branches, `wt` saves your dirty state, evicts the least recently used slot, checks out the new branch, and restores any previously saved state — all in one command. You never think about which directory you're in; `wt` navigates you there.

## Workflow

### Initialize once

From an existing repo:

```sh
cd my-project
wt init
```

Or clone directly:

```sh
mkdir my-project && cd my-project
wt init https://github.com/org/repo.git
```

This creates a container directory with a `.wt/` metadata folder and a fixed number of worktree slots (default: 5), each named with three random memorable words:

```
my-project/
  .wt/                        # metadata, config, stashes
    repo/                      # the original repository (bare clone or moved)
    config.toml
  crimson-maple-river/         # worktree slot 1
  gentle-autumn-spark/         # worktree slot 2
  bright-coral-dawn/           # worktree slot 3
  silver-frost-meadow/         # worktree slot 4
  hollow-pine-creek/           # worktree slot 5
```

One slot is checked out to your starting branch. The rest sit vacant, ready for use.

### Switch branches

```sh
wt checkout feature/login
# or
wt co feature/login
```

Behind the scenes:

1. A centralized `git fetch` runs (all slots share one object store).
2. If the branch is already in a slot, you're navigated there immediately.
3. Otherwise, `wt` picks a vacant slot or evicts the least recently used one.
4. Dirty state in the evicted slot (staged, unstaged, untracked files) is automatically stashed.
5. The target branch is checked out, and any previously saved state for that branch is restored.
6. Template files are regenerated, symlinks are reconciled, and your shell lands in the new slot.

You never run `cd` between worktrees — `wt` does it for you.

### Pin important worktrees

```sh
wt pin       # pin the current worktree
wt unpin     # unpin it
```

Pinned slots are never evicted by LRU.

### Manage stashes

State is saved automatically on eviction and restored automatically on checkout. If you want more control:

```sh
wt stash list               # see all saved stashes
wt stash show feature/login # view the diff
wt stash apply              # manually apply a stash
wt stash drop feature/login # delete a stash
wt co --no-restore my-branch # check out without auto-restoring
```

Stashes that go unused for 7 days after their remote branch is deleted are compressed and archived. `wt clean` lets you review and delete archived stashes interactively.

### Share files across worktrees

Configure directories in `.wt/config.toml` to be symlinked across all slots:

```toml
[shared]
directories = [".claude", ".env.local.d"]
```

A single canonical copy lives in `.wt/shared/`; every worktree gets symlinks to it. If a file is tracked by git in a particular branch, git wins — no symlink is created.

### Generate per-worktree files from templates

Define templates that expand variables like `{{WORKTREE_DIR}}` and `{{BRANCH_NAME}}`:

```toml
[[templates]]
source = "templates/.env.development"
target = ".env.development"
```

Example template:

```
DATABASE_URL=postgres://localhost:5432/myapp_{{WORKTREE_DIR}}
REDIS_PREFIX={{WORKTREE_DIR}}
BRANCH={{BRANCH_NAME}}
```

Each slot gets its own generated copy. Templates regenerate on checkout and sync.

### Use the TUI

Run `wt` with no arguments inside a managed container to open a fullscreen TUI with panels for managing worktrees, stashes, configuration, and templates.

## CLI Reference

| Command | Description |
|---|---|
| `wt init [url]` | Initialize a container. Clone from `url` or restructure the current repo. |
| `wt checkout <branch>` | Switch to a branch (alias: `wt co`). Use `--no-restore` to skip stash restore. |
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
| `wt` | Open the TUI (inside a container) or show help (outside). |

## Installation

### Prerequisites

- Node.js >= 20
- pnpm
- git
- zstd (for stash archival compression)

### From source

```sh
git clone https://github.com/anthropics/wt.git
cd wt
pnpm install
pnpm build
pnpm link --global
```

### Shell integration

Add one of the following to your shell configuration file:

**bash** (`~/.bashrc`):
```sh
eval "$(wt shell-init bash)"
```

**zsh** (`~/.zshrc`):
```sh
eval "$(wt shell-init zsh)"
```

**fish** (`~/.config/fish/config.fish`):
```sh
wt shell-init fish | source
```

This defines a `wt` shell function that wraps the binary, enabling `wt` to change your shell's working directory when switching worktrees.

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
- **TOML** for configuration (`.wt/config.toml`)
- **vitest** for testing, **tsup** for building

## License

MIT
