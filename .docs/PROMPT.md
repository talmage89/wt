# Agent Prompt

You are implementing `wt`, a CLI+TUI for managing git worktrees. All design decisions are finalized.

## First Steps

1. Read `.docs/VISION.md` — the single source of truth for behavior.
2. Read `.docs/PLAN.md` — the project structure and module architecture.
3. Read `.docs/PHASE-1.md` through `.docs/PHASE-9.md` — detailed specs for each phase.
4. Examine the codebase as it exists right now. Determine which phase and step was last completed.
5. Pick up exactly where the last agent left off.

## How to Work

**Small chunks.** You are one of many agents. Do not try to finish the project. Do a small, well-defined piece of work — one module, one command, one test file — then commit and exit. The next agent will continue. Incomplete but correct work is far better than sprawling, half-broken work.

**One milestone per session.** If you implemented or completed anything — a module, a test suite, a command — stop. Commit your work and exit. Do not continue to the next piece. Another agent will pick it up with fresh context.

**When to move to the next phase.** You may ONLY begin work on the next phase if ALL of the following are true:
- The current phase's completion checklist is fully satisfied.
- All tests pass (`pnpm test`).
- No type errors or warnings (`pnpm tsc --noEmit`).
- You have written zero new lines of implementation code in this session.

In other words: if you did any implementation work, you're done for this session even if the phase is now complete. The next agent will verify and advance.

**Commit often.** Commit after every meaningful unit of work — a module, a test file, a bug fix. Small, frequent commits with clear messages. Do not batch large amounts of work into a single commit.

## Tests

Write tests that are likely to catch bugs. If a test just confirms boilerplate or is unlikely to catch a real defect, do not write it. Targeted tests over ceremonial tests. A module with 3 sharp tests beats one with 15 trivial ones.

Run `pnpm test` before every commit. Do not commit failing tests.

## Phase 9: The Endless Phase

Phase 9 is continuous usage testing. It is never complete. Once Phases 1-8 are done, every subsequent agent enters the Phase 9 loop: check for open bugs, fix one if found (then exit), or run a cycle of manual usage tests against the real binary (then exit). Read `.docs/PHASE-9.md` for the full protocol. The key rules:

- **Bug found → log it, stop.** Do not fix it in the same session.
- **Bug open → fix it, stop.** Do not continue to testing in the same session.
- **No bugs, testing clean → log results, stop.** The next agent continues.

## Rules

- The vision document is law. Do not deviate, improvise, or add features not described in it.
- Follow the type signatures and module boundaries in the phase docs.
- Git errors pass through verbatim. Never wrap or suppress them.
- Do not over-engineer. No abstractions beyond what the phase doc calls for.
- If something is ambiguous, re-read the vision. If still ambiguous, leave a `// TODO: ambiguous — see VISION Section X` comment and move on.
