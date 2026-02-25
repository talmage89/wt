# Agent Prompt

You are working on `wt`, a CLI+TUI for managing git worktrees. Core implementation is complete. Your work falls into one of three phases.

## First Steps

1. Read `.docs/VISION.md` — the single source of truth for behavior.
2. Read `.docs/PLAN.md` — project structure and current phase overview.
3. Read `.docs/PHASE-1.md`, `.docs/PHASE-2.md`, `.docs/PHASE-3.md` — the active phase specs.
4. Read `.docs/BUGS.md` — check for open bugs.
5. Determine which phase you should be working in (see below) and follow its protocol.

## Phase Routing

Follow this decision tree:

1. **Open bugs in `.docs/BUGS.md`?** → Fix one bug (Phase 3 protocol), commit, stop.
2. **Phase 1 incomplete?** → Do one unit of planning work, commit, stop.
3. **Phase 2 incomplete?** → Do one implementation item, commit, stop.
4. **All phases current?** → Run one cycle of Phase 3 usage testing, commit, stop.

Phase 1 must be complete before Phase 2 begins. Phase 2 must be complete before Phase 3 resumes as the steady-state loop.

## Phase 1: UX Improvement Planning

The CLI and TUI work but are uninformative. Users don't get feedback after actions, don't know about shell integration, can't create branches, and the TUI doesn't update live. Phase 1 designs all the fixes.

**Your job**: Audit UX gaps, write concrete specs for each improvement, update VISION.md, and write the Phase 2 implementation checklist. Read `.docs/PHASE-1.md` for the full protocol.

Key improvements to design:
- Init feedback (slot summary, shell integration hint)
- Checkout feedback (eviction, stash, branch creation messages)
- Branch creation (`-b` flag, TUI `n` key)
- Cursor visibility fix
- TUI shows all local branches (not just wt-known ones)
- TUI live polling (every ~2 seconds)
- Config edit guidance (what changed, what to do next)
- Hook editing from TUI
- Claude Code worktree pin hook

## Phase 2: UX Improvement Implementation

Implement the specs from Phase 1. One item per session. Read `.docs/PHASE-2.md` for the implementation checklist.

**Your job**: Pick the next uncompleted item, implement it, write tests if applicable, run `pnpm test`, commit, stop.

## Phase 3: Continuous Usage Testing

The endless loop. Read `.docs/PHASE-3.md` for the full protocol.

**Your job**: Either fix one open bug OR run one cycle of 3–5 manual usage tests against the real binary. Never both in the same session.

## How to Work

**One unit of work per session.** Whether it's a planning spec, an implementation item, a bug fix, or a test cycle — do one, commit, exit. The next agent continues.

**Commit often.** Commit after every meaningful unit of work. Small, frequent commits with clear messages.

**Run tests before committing.** `pnpm test` must pass. `pnpm tsc --noEmit` must pass. `pnpm build` must succeed.

## Rules

- The vision document is law. Do not deviate, improvise, or add features not described in it (unless Phase 1 amends it).
- Git errors pass through verbatim. Never wrap or suppress them.
- Do not over-engineer. No abstractions beyond what the specs call for.
- If something is ambiguous, re-read the vision. If still ambiguous, leave a `// TODO: ambiguous — see VISION Section X` comment and move on.
