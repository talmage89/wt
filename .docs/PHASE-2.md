# Phase 2: Container & Slot Management

**Goal**: `wt init` works end-to-end. `wt shell-init` outputs working shell integration. The CLI entry point is wired up.

**Depends on**: Phase 1 (all core utilities).

---

## 2.1 `core/container.ts`

### Purpose
Find, validate, and create `.wt` container directories (VISION Section 1).

### Interface

```ts
export interface ContainerPaths {
  container: string;  // the parent directory holding .wt/ and slots
  wtDir: string;      // absolute path to .wt/
  repoDir: string;    // absolute path to .wt/repo/
}

/**
 * Walk up from `startDir` looking for a directory that contains `.wt/`.
 * Also checks if `startDir` is inside a worktree slot (a sibling of `.wt/`).
 * Returns null if not inside a managed container.
 */
export function findContainer(startDir: string): Promise<ContainerPaths | null>;

/**
 * Create the .wt/ directory structure inside `containerDir`.
 * Creates: .wt/, .wt/repo/, .wt/stashes/, .wt/stashes/archive/,
 *          .wt/shared/, .wt/templates/, .wt/hooks/
 */
export function createContainerStructure(containerDir: string): Promise<string>;

/**
 * Determine which worktree slot the given directory is inside, if any.
 * Returns the slot name (directory name) or null.
 */
export function currentSlotName(
  startDir: string,
  containerPaths: ContainerPaths
): string | null;
```

### `findContainer` logic
1. Starting from `startDir`, check if `path.join(dir, '.wt')` exists and is a directory.
2. If found, return `{ container: dir, wtDir: path.join(dir, '.wt'), repoDir: path.join(dir, '.wt', 'repo') }`.
3. If not, walk up to `path.dirname(dir)`. Stop at filesystem root.
4. Also handle the case where cwd is inside a worktree slot: check if `path.join(path.dirname(startDir), '.wt')` exists (one level up from slot).

### `currentSlotName` logic
Check if `startDir` (or an ancestor before the container) is a direct child of `containerPaths.container`, and if that child is not `.wt`. Return the directory name if so.

### Unit tests
- `findContainer` from inside a container → returns paths.
- `findContainer` from inside a worktree slot → returns container paths.
- `findContainer` from outside → returns null.
- `createContainerStructure` creates all expected subdirectories.
- `currentSlotName` identifies the correct slot.

---

## 2.2 `core/slots.ts`

### Purpose
Create worktree slots, manage LRU selection and eviction (VISION Sections 1.1, 3.1 steps 4-5, 11).

### Interface

```ts
import { State, SlotState } from "./state.js";

/**
 * Create N worktree slots in the container directory.
 * Each slot: `git worktree add --detach <slotPath> <commit>`
 * Returns the names of created slots.
 */
export function createSlots(
  repoDir: string,
  containerDir: string,
  count: number,
  commit: string,
  existingSlotNames: Set<string>
): Promise<string[]>;

/**
 * Find the slot that has the given branch checked out.
 * Returns slot name or null.
 */
export function findSlotForBranch(
  state: State,
  branch: string
): string | null;

/**
 * Select a slot for checking out a new branch.
 * Priority: (a) vacant → (b) LRU unpinned → (c) error if all pinned.
 * Returns the slot name.
 */
export function selectSlotForCheckout(state: State): string;

/**
 * Check if a slot is vacant (detached HEAD, no branch assigned).
 */
export function isVacant(slot: SlotState): boolean;

/**
 * Mark a slot as used with a branch. Updates LRU timestamp.
 */
export function markSlotUsed(
  state: State,
  slotName: string,
  branch: string
): void;

/**
 * Mark a slot as vacant (after eviction/detach).
 */
export function markSlotVacant(state: State, slotName: string): void;
```

### `selectSlotForCheckout` algorithm
1. Collect all vacant slots → if any, return the first one.
2. Collect all non-pinned slots → sort by `last_used_at` ascending → return the oldest.
3. If no non-pinned slots, throw: `"All worktree slots are pinned. Unpin a worktree or increase the slot count to continue."`

### Unit tests (`test/unit/slots.test.ts`)

- `findSlotForBranch` returns correct slot when branch matches.
- `findSlotForBranch` returns null when branch not in any slot.
- `selectSlotForCheckout` prefers vacant slots.
- `selectSlotForCheckout` falls back to LRU non-pinned.
- `selectSlotForCheckout` throws when all non-vacant slots are pinned.
- `isVacant` correctly identifies vacant slots.
- `markSlotUsed` updates branch and timestamp.
- `markSlotVacant` clears branch.

---

## 2.3 `commands/init.ts`

### Purpose
Implement `wt init [url]` (VISION Section 2).

### Interface

```ts
export interface InitOptions {
  url?: string; // if provided, bare-clone from this URL
}

export async function runInit(options: InitOptions): Promise<string>;
// Returns the path to the active worktree slot (for shell navigation).
```

### Flow: `wt init` (from existing repo)

1. **Validate**: Confirm cwd is inside a git repository (`git rev-parse --git-dir`). Error if not.
2. **Validate**: Confirm `.wt/` does not already exist. Error if it does.
3. **Detect repo root**: `git rev-parse --show-toplevel`.
4. **Detect starting branch**: `git symbolic-ref --short HEAD` (the branch currently checked out).
5. **Detect default branch**: Check `origin/HEAD` or fall back to `origin/main` or `origin/master`.
6. **Create container**: The container is the **parent** of the current repo root. Or, restructure in-place:
   - Create `.wt/` inside the current directory.
   - Move `.git/` to `.wt/repo/` (converting to bare if needed, or using `git clone --bare . .wt/repo/` and then working from there).

   **Important decision**: The vision says "move the existing repository into `.wt/repo/`". The cleanest approach:
   - The current directory becomes the container.
   - `git clone --bare . .wt/repo/` to create the bare repo.
   - Remove the old `.git/` directory.
   - Alternatively: move the entire repo directory into `.wt/repo/` and create the container as the former parent. This requires careful handling.

   **Chosen approach**:
   - Container = current repo's parent directory.
   - Move the entire current repo directory into `<container>/.wt/repo/`.
   - This means the user's cwd repo dir becomes `.wt/repo/` and the container is one level up.
   - If the repo is not bare, convert it: `git clone --bare <moved-repo> .wt/repo/` or use `git worktree` from a non-bare repo.

   **Simplest approach that matches the vision**:
   - Container = current directory (the repo root).
   - Move `.git/` to `.wt/repo/.git/` (the repo becomes a bare-like structure at `.wt/repo/`).
   - Actually, we should `git clone --bare . .wt/repo/` then remove `.git/` and working tree files... but that loses uncommitted work.

   **Revised approach**:
   - Container = current working directory.
   - Create `.wt/` structure.
   - Move the `.git` directory: `mv .git .wt/repo` (this makes `.wt/repo` a bare-ish git dir).
   - Set `core.bare = true` in `.wt/repo/config`.
   - Remove all working tree files from the container root (they'll live in worktree slots now).
   - Create worktree slots.
   - Check out the starting branch in one slot.
   - The user's original working tree files are gone — but they exist in git. If there was dirty state, we stash it first.

7. **Stash dirty state** (if any) before moving .git:
   - Run `git stash create --include-untracked` in the original repo.
   - Record the stash hash to restore later.

8. **Create worktree slots**: Use `createSlots()` from `core/slots.ts`. Each slot gets `git worktree add --detach <path> origin/<defaultBranch>`.

9. **Check out starting branch**: In one slot, run `git checkout <startingBranch>`.

10. **Restore stash**: If dirty state was stashed in step 7, apply it in the starting-branch slot.

11. **Generate templates**: Call `generateAllTemplates()`.

12. **Establish symlinks**: Call symlink establishment (basic version — full sync in Phase 4).

13. **Write initial state**: Call `writeState()` with all slot entries.

14. **Write default config**: Call `writeConfig()` with `defaultConfig()`.

15. **Write nav file**: So the shell function can `cd` into the active slot.

### Flow: `wt init <url>` (bare clone)

1. **Validate**: Confirm cwd is empty (or doesn't exist). Error if it contains files (except `.wt/`).
2. **Create container structure**.
3. `git clone --bare <url> .wt/repo/`.
4. Detect default branch from the bare clone.
5. Create worktree slots (all detached at `origin/<default>`).
6. Check out default branch in one slot.
7. Generate templates, establish symlinks, write state/config.
8. Write nav file.

### Error cases
- Already initialized (`.wt/` exists): `"This directory is already a wt-managed container."`
- Not a git repo and no URL: `"Not a git repository. Use 'wt init <url>' to clone, or run from inside a git repository."`
- Non-empty directory with URL: `"Directory is not empty. Use 'wt init' from inside an existing repository, or run from an empty directory."`

### Integration tests (`test/integration/init.test.ts`)

Each test creates a temporary directory, possibly initializes a git repo with some commits, then runs `runInit()`.

- Init from existing repo: verify `.wt/` structure, N slots created, one slot has starting branch, others detached.
- Init from URL: verify bare clone at `.wt/repo/`, slots created, default branch checked out.
- Init with dirty state: verify state is preserved (stashed and restored in active slot).
- Init when already initialized: verify error.
- Init in non-git, non-empty directory: verify error.

---

## 2.4 `commands/shell-init.ts`

### Purpose
Output shell integration code (VISION Section 4).

### Interface

```ts
export type ShellType = "bash" | "zsh" | "fish";

export function runShellInit(shell: ShellType): string;
// Returns the shell function code to stdout.
```

### Shell function behavior

The shell function `wt()` wraps the binary. For commands that produce navigation (`checkout`, `co`, `init`):
1. Call the real `wt` binary with all arguments.
2. Check if a nav file exists at `/tmp/wt-nav-$$`.
3. If it exists, read the path, `cd` to it, and delete the file.
4. If it doesn't exist, do nothing extra.

For all other commands, just delegate to the binary.

### `src/shell/bash.sh`

```bash
wt() {
  local wt_bin
  wt_bin="$(command -v wt)" || { echo "wt: binary not found" >&2; return 1; }

  "$wt_bin" "$@"
  local exit_code=$?

  local nav_file="/tmp/wt-nav-$$"
  if [ -f "$nav_file" ]; then
    local target_dir
    target_dir="$(cat "$nav_file")"
    rm -f "$nav_file"
    if [ -d "$target_dir" ]; then
      cd "$target_dir" || return 1
    fi
    # Execute post-checkout hook if it exists
    local wt_dir
    wt_dir="$(cd "$target_dir" && cd .. && pwd)/.wt"
    if [ -x "$wt_dir/hooks/post-checkout" ]; then
      "$wt_dir/hooks/post-checkout" "$target_dir" "$(cd "$target_dir" && git symbolic-ref --short HEAD 2>/dev/null)"
    fi
  fi

  return $exit_code
}
```

### `src/shell/zsh.sh`
Same as bash (zsh is compatible for this use case).

### `src/shell/fish.fish`
```fish
function wt
    set -l wt_bin (command -v wt)
    or begin; echo "wt: binary not found" >&2; return 1; end

    $wt_bin $argv
    set -l exit_code $status

    set -l nav_file "/tmp/wt-nav-$fish_pid"
    if test -f $nav_file
        set -l target_dir (cat $nav_file)
        rm -f $nav_file
        if test -d $target_dir
            cd $target_dir
        end
        # Post-checkout hook
        set -l wt_dir (cd $target_dir/.. && pwd)"/.wt"
        if test -x $wt_dir/hooks/post-checkout
            $wt_dir/hooks/post-checkout $target_dir (cd $target_dir && git symbolic-ref --short HEAD 2>/dev/null)
        end
    end

    return $exit_code
end
```

### `commands/shell-init.ts` implementation

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runShellInit(shell: ShellType): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const scriptMap: Record<ShellType, string> = {
    bash: "bash.sh",
    zsh: "zsh.sh",
    fish: "fish.fish",
  };
  const scriptPath = path.join(__dirname, "..", "shell", scriptMap[shell]);
  return fs.readFileSync(scriptPath, "utf-8");
}
```

Note: `tsup` must be configured to copy `src/shell/*` to `dist/shell/` as assets, or the shell scripts should be embedded as template literals.

**Better approach**: Embed the shell scripts as string constants in the TypeScript file to avoid asset-path issues after bundling.

---

## 2.5 CLI Entry Point (`src/cli.ts`)

### Purpose
Parse CLI arguments with yargs and route to command handlers.

### Implementation

```ts
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runInit } from "./commands/init.js";
import { runShellInit } from "./commands/shell-init.js";

const cli = yargs(hideBin(process.argv))
  .scriptName("wt")
  .usage("$0 <command> [options]")
  .command(
    "init [url]",
    "Initialize a wt-managed container",
    (yargs) => yargs.positional("url", { type: "string", describe: "Repository URL to clone" }),
    async (argv) => { /* call runInit */ }
  )
  .command(
    "shell-init <shell>",
    "Output shell integration code",
    (yargs) => yargs.positional("shell", { type: "string", choices: ["bash", "zsh", "fish"], demandOption: true }),
    (argv) => { console.log(runShellInit(argv.shell as ShellType)); }
  )
  // Remaining commands are stubs for now:
  .command("checkout <branch>", "Check out a branch", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .alias("co", "checkout")
  .command("fetch", "Centralized git fetch", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .command("stash <action>", "Manage stashes", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .command("sync", "Sync symlinks and templates", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .command("clean", "Clean archived stashes", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .command("list", "List worktree slots", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .alias("ls", "list")
  .command("pin [slot]", "Pin a worktree", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .command("unpin [slot]", "Unpin a worktree", () => {}, () => { console.error("Not yet implemented"); process.exit(1); })
  .demandCommand(0) // 0 args = TUI (Phase 7)
  .strict()
  .help();

cli.parse();
```

### Behavior with no command
When `wt` is run with no arguments:
- Phase 2: print help.
- Phase 7: launch TUI if inside a container, else print help.

---

## 2.6 `bin/wt.mjs`

```js
#!/usr/bin/env node
import "../dist/cli.js";
```

Ensure `package.json` has `"bin": { "wt": "./bin/wt.mjs" }` and the build step produces `dist/cli.js`.

---

## Phase 2 Completion Checklist

- [ ] `core/container.ts` — find/create container, identify current slot
- [ ] `core/slots.ts` — create slots, LRU selection (unit tested)
- [ ] `commands/init.ts` — both flows (existing repo, URL clone)
- [ ] `commands/shell-init.ts` — bash, zsh, fish output
- [ ] Shell scripts embedded or bundled correctly
- [ ] `src/cli.ts` — yargs entry point, `init` and `shell-init` wired, stubs for rest
- [ ] `bin/wt.mjs` — shim working
- [ ] Integration tests for init (both flows, error cases)
- [ ] `pnpm build && node bin/wt.mjs init` works in a test repo
- [ ] `node bin/wt.mjs shell-init bash` outputs valid shell code
