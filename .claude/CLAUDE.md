# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project

`wt` — an opinionated CLI + TUI for managing git worktrees via a fixed pool of reusable slots.

**Read `.docs/VISION.md` before making any implementation decisions.** The vision document is the single source of truth. All code must comply with it exactly. If something is ambiguous, ask — do not guess or deviate.

## Stack

- **Language**: TypeScript
- **Runtime**: Node.js
- **Package Manager**: pnpm
- **TUI**: Ink (React for CLI)
- **Config Format**: TOML (`.wt/config.toml`)
- **Stash Compression**: zstd
- **Shell Integration**: Shell function via `eval "$(wt shell-init <shell>)"`

## Architecture

- Container directory holds `.wt/` (metadata) and worktree slots as siblings.
- Original repo lives in `.wt/repo/` (bare clone or moved repo). Never modified directly.
- Worktree slots are named with random 4-character alphanumeric IDs (permanent names).
- Slots are reused via LRU eviction, not torn down and recreated.
- All worktrees share one git object store; fetch is centralized.

## Key Decisions

- Dirty state (staged, unstaged, untracked) is stashed via `git stash create -u`, anchored with `refs/wt/stashes/*` refs, metadata in `.wt/stashes/`.
- Stashes auto-restore on checkout (opt out with `--no-restore`).
- Shared symlinks: canonical files in `.wt/shared/`, symlinked into worktrees. Git-tracked files take precedence (no symlink created).
- Template files: variable expansion (`{{WORKTREE_DIR}}`, `{{BRANCH_NAME}}`), always overwrite, user responsible for gitignore.
- Pinned worktrees are never LRU-evicted.
- Git errors pass through verbatim — no wrapping or suppression.
- Reconciliation: `wt` silently updates internal state if direct git operations are detected.
- Archive stashes after 7 days (configurable) since last `wt` use of the branch AND remote branch deleted. Deletion is explicit user action only.
