# wt — Git Worktree Control Plane

## Overview

`wt` is an opinionated CLI tool and TUI for managing git worktrees. It maintains a fixed pool of reusable worktree slots, automatically persists working state across branch switches, and provides symlink-based file sharing and template-based file generation across worktrees.

The core philosophy: worktrees are expensive to create and destroy in large repositories. Instead of creating and tearing down worktrees on demand, `wt` maintains a stable pool of worktree directories that are reused via LRU eviction. Branch switches are seamless — dirty state is automatically saved and restored, and the user is navigated to the target worktree without needing to know which slot it occupies.

---

## 1. Directory Layout

A `wt`-managed repository lives inside a **container directory**. The container holds the metadata directory, and all worktree slots as siblings:

```
container/
  .wt/                          # metadata directory
    repo/                        # the original repository (bare clone or moved repo)
    config.toml                  # user configuration
    stashes/                     # stash metadata files
      feature-branch.toml        # metadata for a stashed branch
    shared/                      # canonical location for shared symlinked files
      .claude/                   # example shared directory
    templates/                   # template source files
    hooks/                       # user-defined hook scripts
      post-checkout              # runs after navigating to a new worktree
    state.toml                   # internal state (slot assignments, LRU timestamps, pins)
  crimson-maple-river/           # worktree slot 1
  gentle-autumn-spark/           # worktree slot 2
  bright-coral-dawn/             # worktree slot 3
  silver-frost-meadow/           # worktree slot 4
  hollow-pine-creek/             # worktree slot 5
```

### 1.1 Worktree Slot Naming

Each worktree directory is named with **three random memorable words** separated by hyphens. The word list must be curated: short, memorable, and free of offensive words. Once assigned at initialization, a slot's directory name is permanent for the lifetime of that slot.

### 1.2 Original Repository

The original repository is stored inside `.wt/repo/`. It is never directly modified by the user.

- If `wt init` is run **from inside an existing repository**, the repository is moved into `.wt/repo/`.
- If `wt init <url>` is run **from an empty directory**, a **bare clone** is created at `.wt/repo/`.

All worktree slots are created via `git worktree add` from this repository.

---

## 2. Initialization

### 2.1 `wt init` (from existing repository)

1. Create the container directory structure.
2. Move the existing repository into `.wt/repo/`.
3. Record the current branch as the **starting branch**.
4. Create all configured worktree slots (default: 5) via `git worktree add --detach`, each detached at `origin/main` (or the remote default branch).
5. Check out the **starting branch** in one slot.
6. Generate template files in all worktree slots (see Section 7).
7. Establish symlinks for all configured shared directories (see Section 6).
8. Navigate the user's shell into the slot that has the starting branch checked out.

### 2.2 `wt init <url>` (from empty directory)

1. Create the container directory structure.
2. Bare-clone the repository into `.wt/repo/`.
3. Create all configured worktree slots (default: 5) via `git worktree add --detach`, each detached at `origin/main` (or the remote default branch).
4. Check out the **default branch** in one slot.
5. Generate template files in all worktree slots (see Section 7).
6. Establish symlinks for all configured shared directories (see Section 6).
7. Navigate the user's shell into the slot that has the default branch checked out.

### 2.3 Post-Init State

After initialization:

- One worktree slot is checked out to the starting/default branch. This slot is the **active worktree**.
- All other worktree slots are in a **vacant state** (detached HEAD at the default branch tip).
- The user's shell is inside the active worktree.

### 2.4 Post-Init Output

After `wt init` completes, the following summary is printed to stderr:

```
wt: Initialized with 5 worktree slots.
wt:   crimson-maple-river  (active, branch: main)
wt:   gentle-autumn-spark  (vacant)
wt:   bright-coral-dawn    (vacant)
wt:   silver-frost-meadow  (vacant)
wt:   hollow-pine-creek    (vacant)
wt:
wt: To enable shell navigation (cd on checkout), add to your shell config:
wt:   eval "$(wt shell-init bash)"    # bash
wt:   eval "$(wt shell-init zsh)"     # zsh
wt:   wt shell-init fish | source     # fish
wt:
wt: Then restart your shell or run the eval command now.
```

The shell integration hint is omitted if `WT_SHELL_INTEGRATION=1` is set in the environment (i.e., the shell wrapper has already been sourced).

---

## 3. Branch Checkout

The primary user-facing operation is `wt checkout <branch>` (alias: `wt co <branch>`).

### 3.0 Branch Creation

To create a new branch and check it out:

```
wt checkout -b <new-branch> [<start-point>]
```

- If `<start-point>` is omitted, the new branch is created from `origin/<default-branch>`.
- If `<start-point>` is specified, the new branch is created from that ref.
- After creation, the checkout flow (Section 3.1) proceeds normally: slot selection, eviction if needed, stash restore if applicable.

This mirrors `git checkout -b` semantics.

### 3.1 Checkout Flow

1. **Fetch**: Run a centralized `git fetch` against the remote. All worktrees share the same object store, so one fetch updates all of them.
2. **Archive scan**: Check all stashed branches against remote state. Flag stashes for archival if the remote branch has been deleted AND the stash is older than 7 days (see Section 5.3).
3. **Branch already in a slot?** If the target branch is already checked out in an existing worktree slot, navigate the user to that slot. Done.
4. **Find a slot**: Select a target worktree slot using the following priority:
   - **(a)** A **vacant** slot (detached HEAD, no branch assigned). If multiple vacant slots exist, pick any.
   - **(b)** The **least recently used** non-pinned slot.
   - **(c)** If all slots are pinned, **fail with an error**: `"All worktree slots are pinned. Unpin a worktree or increase the slot count to continue."`
5. **Evict** (if the selected slot is not vacant):
   - If the slot has dirty state (any output from `git status`), create a stash (see Section 5.1) and store it.
   - Detach HEAD in the slot (`git checkout --detach`).
6. **Checkout**: Check out the target branch in the selected slot (`git checkout <branch>`). If the branch does not exist locally, create it from `origin/<branch>` or prompt the user.
7. **Restore stash**: If a stash exists for the target branch and `--no-restore` was not passed, apply it automatically (see Section 5.2). If `--no-restore` was passed, the stash is preserved but not applied; the user can apply it later via `wt stash apply`.
8. **Regenerate templates**: Regenerate all template files in the target slot (see Section 7), since branch-name variables may have changed.
9. **Reconcile symlinks**: Ensure shared symlinks are correctly established, respecting git-tracked file precedence (see Section 6.3).
10. **Execute post-checkout hook**: If `.wt/hooks/post-checkout` exists, execute it with the worktree path and branch name as arguments.
11. **Navigate**: Change the user's shell working directory to the target worktree slot.

### 3.2 Checkout Feedback

After checkout completes, `wt` prints a brief summary to stderr. Only lines that apply are shown:

```
wt: Checked out feature/my-branch in crimson-maple-river
wt: Evicted main from crimson-maple-river (dirty state stashed)
wt: Restored stash from 2d ago
wt: Created local branch feature/new from origin/main
wt: Navigating to /path/to/crimson-maple-river
```

- The "Checked out" line always appears.
- The "Evicted" line appears only when LRU eviction occurred.
- "(dirty state stashed)" is appended to the eviction line only if a stash was created.
- The "Restored stash" line appears only when a saved stash was applied.
- The "Created local branch" line appears only when a new branch was created from remote.
- The "Navigating" line appears only when shell integration is active (`WT_SHELL_INTEGRATION=1`).

### 3.3 Reconciliation

On every `wt` command, `wt` scans all worktree slots and updates its internal state:

- Which branch is checked out in each slot.
- LRU timestamps.
- Pin status.

If a branch has changed due to direct `git checkout` usage (bypassing `wt`), `wt` silently updates its internal mapping to reflect reality. No warning is emitted; the tool adapts.

---

---

## 4. Shell Integration

A child process cannot change the parent shell's working directory. To enable seamless navigation, `wt` requires shell integration.

### 4.1 Setup

The user adds one of the following to their shell configuration:

- **bash**: `eval "$(wt shell-init bash)"`
- **zsh**: `eval "$(wt shell-init zsh)"`
- **fish**: `wt shell-init fish | source`

This defines a shell function `wt()` that wraps the `wt` binary. Shell scripts must export `WT_SHELL_INTEGRATION=1` so the CLI can detect that shell integration is active.

### 4.2 Mechanism

For commands that require directory changes (e.g., `wt checkout`):

1. The `wt` binary performs all operations (fetch, eviction, stash, checkout, etc.).
2. Upon completion, the binary writes the target worktree path to a temporary file (e.g., `/tmp/wt-nav-<pid>`).
3. The shell function reads the file and executes `cd <path>`.
4. The temporary file is deleted.

For commands that do not require directory changes, the shell function delegates directly to the binary.

### 4.3 User-Defined Post-Checkout Hook

The file `.wt/hooks/post-checkout` (if it exists and is executable) is executed after the shell navigates to the new worktree. It receives two arguments:

1. `$1` — Absolute path to the new worktree.
2. `$2` — Branch name checked out in the new worktree.

This hook is distinct from git's own `post-checkout` hook. It runs in the user's shell context after navigation.

---

## 5. State Persistence (Stashing)

When a worktree slot is evicted, all dirty state is saved. When a branch is revisited, its state is restored.

### 5.1 Saving State (Eviction)

"Dirty state" is defined as everything that appears in `git status`: staged changes, unstaged changes, and untracked files (excluding gitignored files).

1. Run `git stash create --include-untracked` in the worktree. This produces a commit hash representing the full dirty state without actually modifying the working tree.
2. Anchor the commit with a git ref: `git update-ref refs/wt/stashes/<encoded-branch-name> <commit-hash>`. This prevents the commit from being garbage collected.
3. Write metadata to `.wt/stashes/<encoded-branch-name>.toml`:

```toml
branch = "feature/my-branch"
commit = "abc1234"           # the commit the branch was on at eviction time
stash_ref = "def5678"        # the stash commit hash
created_at = 2026-02-22T10:30:00Z
last_used_at = 2026-02-22T10:30:00Z  # reset each time the branch is used via wt
status = "active"            # active | archived
```

4. If the worktree has no dirty state, no stash is created.

The `last_used_at` timestamp is reset whenever the branch is checked out via `wt`. This means actively used branches never age into archival, even if the stash itself was created long ago. The 7-day archive timer only begins counting from the **last time the user interacted with the branch through `wt`**.

### 5.2 Restoring State

When the user checks out a branch that has a saved stash (and `--no-restore` is not set):

1. Look up the stash ref from `.wt/stashes/<encoded-branch-name>.toml`.
2. Apply it via `git stash apply <stash-ref>`.
3. If the apply succeeds cleanly, delete the ref (`git update-ref -d refs/wt/stashes/<encoded-branch-name>`) and delete the metadata file.
4. If the apply produces **merge conflicts** (e.g., the branch was rebased since the stash was created), `wt` emits a warning and leaves the conflicts in the worktree for the user to resolve manually. The stash ref and metadata are **retained** so the user can retry or inspect later.

Restoration is automatic by default and requires no user interaction. The user can opt out with `wt checkout --no-restore <branch>`.

### 5.2.1 Manual Stash Operations

If the user checks out with `--no-restore`, or if auto-restore produced conflicts and they want to retry, the following commands are available:

- `wt stash list` — List all saved stashes with branch, age, status, and the base commit they were created against.
- `wt stash apply [branch]` — Manually apply a stash for the given branch (defaults to the current branch). On success, the stash is deleted. On conflict, the stash is retained.
- `wt stash drop [branch]` — Delete a stash without applying it (with confirmation).
- `wt stash show [branch]` — Display the diff contents of a stash.

### 5.3 Stash Lifecycle

Stashes progress through three states:

| State | Condition | Storage |
|---|---|---|
| **Active** | Branch exists on remote, OR less than 7 days since last `wt` use of the branch | Git ref + metadata TOML |
| **Archived** | Branch deleted on remote AND stash is older than 7 days | Compressed patch file (`.wt/stashes/archive/<branch>.patch.zst`) + metadata TOML. Git ref is deleted to free object storage. |
| **Deleted** | Explicit user action only | All artifacts removed |

### 5.4 Archive Scanning

Archive scanning occurs during:

- `wt checkout` (as part of the fetch step).
- `wt fetch` (manual fetch command).
- `wt clean` (manual cleanup command).

During an archive scan:

1. For each active stash, check if the branch exists on the remote (`git ls-remote --heads origin <branch>`).
2. If the branch does not exist on the remote AND the stash's `created_at` is older than 7 days:
   - Export the stash as a patch: `git stash show -p --include-untracked <stash-ref> | zstd > .wt/stashes/archive/<branch>.patch.zst`.
   - Delete the git ref: `git update-ref -d refs/wt/stashes/<encoded-branch-name>`.
   - Update the metadata TOML: set `status = "archived"`, record `archived_at` timestamp and archive file path.

### 5.5 Stash Deletion

Stashes (active or archived) are only deleted via explicit user action:

- `wt clean` — Interactive CLI prompt listing archived stashes with their age and size. User selects which to delete.
- TUI — The "Manage Stashes" panel (see Section 8) allows browsing and deleting archived stashes.

Deletion removes the metadata TOML, the archived patch file (if archived), and the git ref (if still active).

---

## 6. Shared Symlinks

Shared symlinks allow gitignored files to be synchronized across all worktrees. A single canonical copy of each file is stored in `.wt/shared/`, and each worktree gets symlinks pointing to it.

### 6.1 Configuration

In `.wt/config.toml`:

```toml
[shared]
directories = [".claude", ".env.local.d"]
```

Each entry is a path relative to the worktree root. All files within these directories (recursively) are managed as shared symlinks.

### 6.2 Canonical Storage

Shared files live in `.wt/shared/<directory>/`. For example, if `.claude` is configured:

```
.wt/shared/.claude/
  settings.json
  CLAUDE.md
```

Each worktree slot gets:

```
crimson-maple-river/.claude/settings.json  -> ../../.wt/shared/.claude/settings.json
crimson-maple-river/.claude/CLAUDE.md      -> ../../.wt/shared/.claude/CLAUDE.md
```

Editing the file in any worktree edits the single canonical copy.

### 6.3 Git-Tracked File Conflict

If a file is configured as shared but is **tracked by git** in the current branch of a worktree:

- **Git wins.** The symlink is not created. The git-tracked version of the file is used as-is.
- `wt` emits a warning: `"Skipping symlink for <path>: file is tracked by git in branch <branch>."`.
- When the user switches that worktree to a branch where the file is not tracked, the symlink is established.

### 6.4 Synchronization

Shared symlink propagation is **manual**, triggered by:

- `wt sync` — Scans all configured shared directories across all worktrees. For each worktree:
  - If a file exists as a real file (not a symlink) in a shared directory and is not git-tracked, move it to `.wt/shared/` and replace it with a symlink.
  - If a new file exists in `.wt/shared/` but a worktree lacks the symlink, create it (respecting git-tracked conflict rules per Section 6.3).
  - If a symlink is broken (target deleted), remove it.
- `wt checkout` — Symlinks are reconciled in the target worktree as part of the checkout flow (Section 3.1, step 9).
- `wt init` — Symlinks are established in all worktrees.

---

## 7. Template Files

Template files are files that are programmatically generated in each worktree with variable expansion. They are unique per worktree (not shared).

### 7.1 Configuration

In `.wt/config.toml`:

```toml
[[templates]]
source = "templates/docker-compose.override.yml"  # relative to .wt/
target = "docker-compose.override.yml"             # relative to worktree root

[[templates]]
source = "templates/.env.development"
target = ".env.development"
```

### 7.2 Template Variables

Templates support the following variables, using `{{VARIABLE}}` syntax:

| Variable | Value | Example |
|---|---|---|
| `{{WORKTREE_DIR}}` | The three-random-words directory name of the worktree | `crimson-maple-river` |
| `{{BRANCH_NAME}}` | The branch currently checked out in the worktree | `feature/my-branch` |

Example template (`.wt/templates/.env.development`):

```
DATABASE_URL=postgres://localhost:5432/myapp_{{WORKTREE_DIR}}
REDIS_PREFIX={{WORKTREE_DIR}}
BRANCH={{BRANCH_NAME}}
```

Generated output in `crimson-maple-river/.env.development`:

```
DATABASE_URL=postgres://localhost:5432/myapp_crimson-maple-river
REDIS_PREFIX=crimson-maple-river
BRANCH=feature/my-branch
```

### 7.3 Generation Behavior

- Generated files **always overwrite** existing files at the target path. They are programmatic artifacts, not user-edited files.
- It is the **user's responsibility** to gitignore generated files.
- Generated files are **coupled to the worktree slot**, not the branch. The `{{WORKTREE_DIR}}` variable is stable; the `{{BRANCH_NAME}}` variable changes on checkout.

### 7.4 Generation Triggers

Template files are generated during:

| Trigger | Scope |
|---|---|
| `wt init` | All worktree slots |
| `wt checkout <branch>` | The target worktree slot only |
| `wt sync` | All worktree slots |
| TUI "Regenerate Templates" action | User-selected worktree slot(s) |

### 7.5 TUI Template Editing

The TUI provides an option to edit template source files in-terminal. After editing, the TUI prompts to regenerate the template across all worktree slots, overwriting existing generated files.

---

## 8. TUI

`wt` with no arguments opens a fullscreen TUI if the current working directory is inside a `wt`-managed container or worktree. If not, it displays CLI help/usage.

### 8.1 Main Menu

The TUI main screen is a list of top-level actions:

1. **Manage Worktrees** — View and interact with worktree slots.
2. **Manage Stashes** — View and delete archived stashes.
3. **Edit Configuration** — Modify `.wt/config.toml` in-terminal.
4. **Edit Templates** — Edit template source files, regenerate across worktrees.
5. **Edit Hooks** — Create and edit hook scripts in `.wt/hooks/`.

### 8.2 Manage Worktrees Panel

The worktree panel is **branch-centric** — it displays a unified list of branches, not worktree slots. The list is ordered by recency (most recently used first).

#### 8.2.1 Branch Display

Each entry in the list represents a branch. Branches fall into three visual tiers:

1. **Pinned branches** — Displayed at the top of the list, regardless of recency. Shown in **bright white** with a pin indicator and a colored status dot (see below). Pinned branches are always in a worktree slot.

2. **Active branches** (in a worktree slot, not pinned) — Displayed in **bright white** with a colored status dot indicating worktree state. Sorted by recency below pinned entries.

3. **Inactive branches** (not in any worktree slot) — Displayed in **dim/faded text** below active branches. Includes:
   - Branches previously checked out via `wt` (tracked in `wt` history), sorted by recency of last `wt` checkout.
   - All other local branches (from `git branch`) not already listed above, shown at the bottom of the inactive tier.
   Deduplication: each branch appears exactly once regardless of how many sources it appears in.

#### 8.2.2 Status Indicators

Active branches (those occupying a worktree slot) display a colored dot:

- **Green dot** — Worktree is clean (no output from `git status`).
- **Yellow dot** — Worktree is dirty (uncommitted changes exist).

Additional metadata shown per entry:

- Worktree slot name (three random words) — shown as secondary text for active branches.
- Time since last used — relative timestamp (e.g., "2h ago", "3d ago").
- Stash indicator — if a saved stash exists for an inactive branch, show a marker.

#### 8.2.3 Available Actions

On an **active branch** (in a worktree slot):

- **Checkout** — Navigate the shell to this worktree.
- **Pin / Unpin** — Toggle pin status.
- **View Status** — Show `git status` output for the worktree.

On an **inactive branch** (not in a worktree slot):

- **Checkout** — Check out this branch (triggers slot selection / LRU eviction) and navigate to it.
- **View Stash** — If a stash exists, display the diff contents.

From anywhere in the Worktree Panel:

- **`n` key — Create New Branch** — Opens a text input prompt for the new branch name. The branch is created from `origin/<default-branch>` and immediately checked out (triggering the full checkout flow). The user may optionally specify a start point.

#### 8.2.4 Live Polling

The TUI polls for state changes every 2 seconds while the Worktree Panel is visible and `$EDITOR` is not open. On each tick:

- Re-read `.wt/state.toml`.
- Run `git status --porcelain` per active slot (lightweight).
- If any slot's branch or dirty status changed, update the display.
- Re-run reconciliation to detect direct `git checkout` changes.

Polling pauses when an editor is open (to avoid interfering with editor I/O) and resumes when the editor exits.

#### 8.2.5 Branch Search

A search action is available from the worktree panel (e.g., `/` or a dedicated keybinding) that allows the user to fuzzy-search across **all** local and remote branches — not just those in `wt` history. Selecting a branch from search results triggers a checkout.

### 8.3 Manage Stashes Panel

Displays all stashes, grouped by status (active, archived).

Each entry shows:

- Branch name.
- Stash age.
- Size (of archived patch file, if archived).
- Status.

Available actions:

- **Apply** — Apply the stash to its associated branch. If the branch is in an active worktree, apply directly. If not, prompt to checkout the branch first (which triggers slot selection / LRU eviction), then apply.
- **View Diff** — Display the stash contents.
- **Delete** — Remove the stash (with confirmation).
- **Bulk Delete** — Select multiple archived stashes for deletion.

The Stash Panel also polls for changes every 2 seconds (same mechanism as the Worktree Panel).

### 8.4 Edit Configuration Panel

Opens `.wt/config.toml` in `$EDITOR` for modification.

After the editor closes, `wt` compares the new config with the snapshot taken before the editor opened and displays a diff summary:

```
Config updated.
  slot_count: 5 → 7 (run any wt command to create new slots)
  shared.directories: added ".env.local.d" (run 'wt sync' to propagate)
  templates: added 1 template (run 'wt sync' to generate)
```

If no changes were made: `No changes.`

This summary appears immediately after returning to the TUI and guides the user on any follow-up actions required.

### 8.5 Edit Templates Panel

Lists all configured template source files. Selecting one opens it in `$EDITOR`. After saving, prompts to regenerate the template across all worktrees.

### 8.6 Edit Hooks Panel

Lists all files in `.wt/hooks/` and their descriptions.

If no hooks exist, offers to create the `post-checkout` hook with a commented template:

```bash
#!/usr/bin/env bash
# post-checkout hook — runs after wt navigates to a new worktree
# $1 = absolute path to the worktree
# $2 = branch name checked out
WORKTREE_PATH="$1"
BRANCH="$2"
```

Selecting an existing hook opens it in `$EDITOR`. After editing, the panel checks whether the file is executable. If not, it offers to run `chmod +x` on the file.

Available actions per hook entry:
- **Edit** — Open in `$EDITOR`.
- **Make Executable / Already Executable** — Toggle based on current mode.
- **Delete** — Remove the hook file (with confirmation).

---

## 9. CLI Commands

| Command | Description |
|---|---|
| `wt init [url]` | Initialize a `wt`-managed container. If `url` is provided, clone from it. Otherwise, restructure the current repository. |
| `wt checkout <branch>` | Check out a branch, evicting the LRU slot if necessary. Alias: `wt co`. Supports `--no-restore` to skip automatic stash restoration. |
| `wt checkout -b <branch> [start]` | Create a new branch from `<start>` (default: `origin/<default-branch>`) and check it out. |
| `wt fetch` | Run a centralized `git fetch` and trigger archive scanning. |
| `wt stash list` | List all saved stashes with branch, age, status, and base commit. |
| `wt stash apply [branch]` | Apply a saved stash for the given branch (defaults to current). Deletes stash on clean apply; retains on conflict. |
| `wt stash drop [branch]` | Delete a saved stash without applying (with confirmation). |
| `wt stash show [branch]` | Display the diff contents of a saved stash. |
| `wt sync` | Propagate shared symlinks and regenerate template files across all worktrees. |
| `wt clean` | Interactive prompt to review and delete archived stashes. Triggers archive scanning. |
| `wt list` | Display all worktree slots with their branch, status, pin state, and last-used time. Alias: `wt ls`. |
| `wt pin [slot]` | Pin a worktree slot to prevent LRU eviction. If no slot specified, pin the current worktree. |
| `wt unpin [slot]` | Unpin a worktree slot. If no slot specified, unpin the current worktree. |
| `wt shell-init <shell>` | Output shell integration code for the given shell (`bash`, `zsh`, `fish`). |
| `wt` | Open the TUI (if inside a managed container/worktree) or display help (if not). |

---

## 10. Configuration

Configuration lives in `.wt/config.toml`.

```toml
# Number of worktree slots to maintain.
slot_count = 5

# Directories to share across worktrees via symlinks.
# Paths are relative to the worktree root.
[shared]
directories = [".claude"]

# Template file definitions.
[[templates]]
source = "templates/.env.development"    # relative to .wt/
target = ".env.development"              # relative to worktree root

[[templates]]
source = "templates/docker-compose.override.yml"
target = "docker-compose.override.yml"

# Number of days before a stash with a deleted remote branch is archived.
archive_after_days = 7
```

### 10.1 Changing Slot Count

- **Increasing**: New vacant worktree slots are created immediately (detached HEAD at the default branch tip). Template files are generated and symlinks established.
- **Decreasing**: Excess worktree slots are evicted immediately, starting from the least recently used. Dirty state is stashed per Section 5.1. If the number of **pinned** worktrees exceeds the new slot count, the operation **fails with an error**: `"Cannot reduce slot count to <N>: <M> worktrees are pinned. Unpin worktrees first or choose a higher count."`

---

## 11. Worktree Pinning

A pinned worktree is never selected for LRU eviction.

- Pins are stored in `.wt/state.toml`.
- Pins survive across `wt` operations.
- If all non-vacant slots are pinned and the user attempts `wt checkout <new-branch>`:
  - If vacant slots exist, use a vacant slot (pins are irrelevant for vacant slots).
  - If no vacant slots exist, fail with: `"All worktree slots are pinned. Unpin a worktree or increase the slot count to continue."`

---

## 12. Centralized Fetch

All worktrees share the same git object store (via the bare repo in `.wt/repo/`). A single `git fetch` updates remote-tracking branches for all worktrees.

Fetch is triggered:

- Automatically on every `wt checkout`.
- Manually via `wt fetch`.

No individual worktree fetches independently.

---

## 13. Technology

| Aspect | Choice |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| Package Manager | pnpm |
| TUI Framework | Ink (React for CLI) |
| Config Format | TOML |
| Stash Compression | zstd |
| Shell Integration | Shell function via `eval "$(wt shell-init <shell>)"` |

---

## 14. Encoding Branch Names

Branch names may contain characters that are invalid in file paths or git ref names (e.g., `/`, `..`). Wherever a branch name is used as a file name or ref component, it must be encoded:

- Replace `/` with `--`.
- Replace any other characters that are invalid in file paths with their percent-encoded equivalents.

Example: `feature/my-branch` becomes `feature--my-branch` in file paths and ref names.

---

## 15. Error Handling

### 15.1 `wt`-Level Errors

| Scenario | Behavior |
|---|---|
| All slots pinned, no vacant slots, user tries checkout | Error: advise to unpin or increase slot count |
| Slot count reduced below pinned count | Error: advise to unpin or increase count |
| `wt init` in non-empty, non-git directory | Error: directory must be empty or contain a git repository |
| `wt` command outside managed container | Display help/usage |
| Direct `git checkout` detected | Silently reconcile internal state |
| Shared symlink target is git-tracked | Skip symlink, warn user |

### 15.2 Stash Restore Conflicts

When a stash auto-restore (or manual `wt stash apply`) produces merge conflicts:

1. `wt` warns the user that conflicts exist and need manual resolution.
2. The stash ref and metadata are **retained** (not deleted) so the user can inspect the original stash.
3. The user resolves conflicts normally via git.
4. After resolution, the user can run `wt stash drop` to clean up the retained stash, or it will be cleaned up naturally if the branch is evicted and re-stashed later.

The user can avoid this entirely by using `wt checkout --no-restore <branch>` and then selectively applying with `wt stash apply`.

### 15.3 Git Error Pass-Through

All git errors are passed through to the user verbatim. `wt` does not wrap, reinterpret, or suppress git error messages. If `git checkout`, `git fetch`, `git stash apply`, or any other git operation fails, the user sees git's native error output.

---

## 16. Claude Code Integration

### 16.1 Worktree Pinning Hook

When Claude Code runs a prompt inside a `wt`-managed worktree, that worktree could be evicted by a concurrent `wt checkout` in another terminal. To prevent this, users can configure a Claude Code hook that pins the worktree for the duration of the Claude Code session.

Add the following to Claude Code's hook configuration (`.claude/settings.json` or the equivalent hooks file):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "wt pin 2>/dev/null || true"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "wt unpin 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

The `|| true` ensures that if `wt` is not available or the current directory is not inside a managed worktree, the hook silently does nothing.

This hook can be placed in `.wt/shared/.claude/settings.json` so it is automatically symlinked into all worktrees, requiring no per-worktree configuration.

### 16.2 `wt hooks show` (Optional)

`wt hooks show claude-code` outputs the above JSON to stdout, allowing the user to inspect or redirect it:

```
wt hooks show claude-code >> .claude/settings.json
```

This subcommand is optional; the hook definition above is the primary deliverable.
