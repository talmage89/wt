# Phase 1: Project Scaffolding & Core Utilities

**Goal**: Buildable TypeScript project with all pure-logic core modules implemented and unit-tested.

---

## 1.1 Project Initialization

### package.json

```jsonc
{
  "name": "wt",
  "version": "0.1.0",
  "type": "module",
  "bin": { "wt": "./bin/wt.mjs" },
  "main": "./dist/cli.js",
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/ test/"
  }
}
```

### Dependencies

**Runtime:**
- `yargs` — CLI parsing (defer wiring to Phase 2, but install now)
- `smol-toml` — TOML parse/stringify
- `execa` — subprocess execution for git

**Dev:**
- `typescript`
- `tsx` — dev-time TS execution
- `tsup` — bundler
- `vitest` — test runner
- `@types/node`
- `@types/yargs`
- `eslint` + `@typescript-eslint/*`

### tsconfig.json

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### tsup.config.ts

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  sourcemap: true,
  dts: true,
  clean: true,
});
```

### vitest.config.ts

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
```

### bin/wt.mjs

```js
#!/usr/bin/env node
import "../dist/cli.js";
```

### Directory scaffolding

Create empty directories:
- `src/commands/`
- `src/core/`
- `src/tui/`
- `src/shell/`
- `src/data/`
- `test/unit/`
- `test/integration/`
- `test/fixtures/`

Create a stub `src/cli.ts`:
```ts
#!/usr/bin/env node
console.log("wt: not yet implemented");
```

### Acceptance criteria
- `pnpm install` succeeds
- `pnpm build` produces `dist/cli.js`
- `pnpm test` runs (zero tests is ok)
- `node bin/wt.mjs` prints the stub message

---

## 1.2 `core/branch-encode.ts`

### Purpose
Encode/decode branch names for use in file paths and git ref names (VISION Section 14).

### Interface

```ts
/**
 * Encode a branch name for safe use in file paths and git ref components.
 * - `/` becomes `--`
 * - Other invalid path chars become percent-encoded (%XX)
 */
export function encodeBranch(name: string): string;

/**
 * Decode an encoded branch name back to the original.
 */
export function decodeBranch(encoded: string): string;
```

### Encoding rules
1. Replace `/` with `--`.
2. Replace any character that is not `[a-zA-Z0-9._-]` (after `/` replacement) with `%XX` hex encoding.
3. Handle edge cases: branch names starting with `.`, containing `..`, or containing consecutive `-`.

### Unit tests (`test/unit/branch-encode.test.ts`)

| Input | Encoded |
|---|---|
| `main` | `main` |
| `feature/my-branch` | `feature--my-branch` |
| `feature/nested/deep` | `feature--nested--deep` |
| `fix/hello world` | `fix--hello%20world` |
| `release/v1.0` | `release--v1.0` |
| `my-branch` | `my-branch` |

- Round-trip: `decodeBranch(encodeBranch(x)) === x` for all test cases.
- Encoded output must be a valid file name (no `/`, no `..`, no null bytes).

---

## 1.3 `src/data/words.ts` + `core/words.ts`

### Purpose
Curated word list and random 3-word slot name generator (VISION Section 1.1).

### `src/data/words.ts`

Export a `const WORDS: readonly string[]` containing ~300-500 curated words. Criteria:
- 3-7 characters long
- Common English words (adjectives and nouns mixed)
- Easy to read, pronounce, and type
- No offensive, violent, or sensitive words
- Categories: colors, nature, weather, animals, materials, textures, shapes, time

Example subset:
```
amber, aspen, atlas, autumn, azure, birch, blaze, bloom, bolt, breeze,
bright, brook, calm, cedar, chill, cliff, cloud, coral, crane, creek,
crisp, crown, crystal, dusk, dawn, delta, drift, eagle, ember, fern,
flame, flint, forest, frost, glade, gleam, grove, haven, hawk, hazel,
heron, holly, ivory, jade, lark, leaf, light, linen, lunar, maple,
marsh, meadow, mist, moss, noble, north, oak, onyx, opal, orbit,
otter, pearl, peak, pine, plum, pond, prism, quartz, rain, raven,
ridge, river, robin, sage, shade, silver, slate, snow, south, spark,
spruce, steel, stone, storm, swift, thorn, tide, tiger, trail, vale,
velvet, vine, violet, wave, willow, wind, wren, zenith ...
```

### `core/words.ts`

```ts
import { WORDS } from "../data/words.js";

/**
 * Generate a unique 3-word hyphenated name not in `existingNames`.
 * Uses cryptographically random selection.
 * Retries on collision (statistically near-impossible with 300+ words).
 */
export function generateSlotName(existingNames: Set<string>): string;
```

### Implementation notes
- Use `crypto.randomInt()` for random word selection (no `Math.random()`).
- Format: `word1-word2-word3` (all lowercase, hyphen-separated).
- Retry up to 100 times if collision with `existingNames`; throw if exhausted (should never happen).

### Unit tests (`test/unit/words.test.ts`)

- Generated name matches pattern `/^[a-z]+-[a-z]+-[a-z]+$/`.
- Generated name uses words from the `WORDS` array.
- Two consecutive calls produce different names (probabilistic but safe with 300+ words).
- Avoids names in `existingNames` set.
- All words in `WORDS` are 3-7 chars, lowercase alpha only.
- No duplicate words in `WORDS`.

---

## 1.4 `core/config.ts`

### Purpose
Read/write `.wt/config.toml` (VISION Section 10).

### Types

```ts
export interface TemplateConfig {
  source: string; // relative to .wt/
  target: string; // relative to worktree root
}

export interface SharedConfig {
  directories: string[]; // paths relative to worktree root
}

export interface Config {
  slot_count: number;       // default: 5
  archive_after_days: number; // default: 7
  shared: SharedConfig;
  templates: TemplateConfig[];
}
```

### Interface

```ts
/**
 * Read config from .wt/config.toml. Returns defaults for missing fields.
 */
export function readConfig(wtDir: string): Promise<Config>;

/**
 * Write config to .wt/config.toml.
 */
export function writeConfig(wtDir: string, config: Config): Promise<void>;

/**
 * Return a Config with all defaults (used during init).
 */
export function defaultConfig(): Config;
```

### Behavior
- Missing file → return `defaultConfig()`.
- Missing fields → fill with defaults (`slot_count: 5`, `archive_after_days: 7`, `shared.directories: []`, `templates: []`).
- Extra/unknown fields → preserve them (round-trip safe).

### Unit tests (`test/unit/config.test.ts`)

- Parse a full config TOML string → correct `Config` object.
- Parse a minimal config (missing optional fields) → defaults filled.
- Missing file → returns `defaultConfig()`.
- Serialize a `Config` → valid TOML that round-trips.
- Default config has correct values.

---

## 1.5 `core/state.ts`

### Purpose
Read/write `.wt/state.toml` — internal state tracking slot assignments, LRU timestamps, and pins (VISION Sections 3.2, 11).

### Types

```ts
export interface SlotState {
  branch: string | null;    // null = vacant (detached HEAD)
  last_used_at: string;     // ISO 8601 timestamp
  pinned: boolean;
}

export interface BranchHistoryEntry {
  branch: string;
  last_checkout_at: string; // ISO 8601
}

export interface State {
  slots: Record<string, SlotState>;  // keyed by slot directory name
  branch_history: BranchHistoryEntry[]; // for TUI inactive branch list
}
```

### Interface

```ts
export function readState(wtDir: string): Promise<State>;
export function writeState(wtDir: string, state: State): Promise<void>;
export function defaultState(): State;
```

### Behavior
- Missing file → return `defaultState()` (empty slots, empty history).
- `branch_history` tracks branches the user has ever checked out via `wt`, ordered by recency. Used for the TUI's inactive branch list (VISION Section 8.2.1, tier 3).

### Unit tests (`test/unit/state.test.ts`)

- Parse a state TOML with multiple slots → correct `State` object.
- Vacant slot has `branch: null`.
- Serialize a `State` → valid TOML that round-trips.
- Missing file → returns empty state.
- `branch_history` entries preserve order.

---

## 1.6 `core/nav.ts`

### Purpose
Write/read/clean navigation files for shell integration (VISION Section 4.2).

### Interface

```ts
/**
 * Write the target directory to a temp nav file.
 * Returns the path to the nav file.
 * File name: /tmp/wt-nav-<pid>
 */
export function writeNavFile(targetDir: string): Promise<string>;

/**
 * Read the target directory from a nav file.
 */
export function readNavFile(navFilePath: string): Promise<string>;

/**
 * Delete the nav file.
 */
export function cleanNavFile(navFilePath: string): Promise<void>;

/**
 * Get the nav file path for the current process.
 */
export function navFilePath(): string;
```

### Implementation notes
- File path: `/tmp/wt-nav-${process.ppid}` (use parent PID so the shell function can find it).
- File contains a single line: the absolute path to the target directory.
- `cleanNavFile` is a no-op if the file doesn't exist.

### Unit tests (`test/unit/nav.test.ts`)

- Write → read → returns same path.
- Clean removes the file.
- Clean on non-existent file doesn't throw.
- Nav file path uses `process.ppid`.

---

## 1.7 `core/templates.ts`

### Purpose
Template variable expansion and file generation (VISION Section 7).

### Interface

```ts
import { TemplateConfig } from "./config.js";

/**
 * Expand template variables in a string.
 */
export function expandTemplate(
  content: string,
  vars: { WORKTREE_DIR: string; BRANCH_NAME: string }
): string;

/**
 * Generate template files for a single worktree slot.
 * Reads each template source from wtDir, expands variables,
 * writes to the target path in the worktree.
 */
export function generateTemplates(
  wtDir: string,
  worktreeDir: string,
  slotName: string,
  branchName: string,
  templates: TemplateConfig[]
): Promise<void>;

/**
 * Generate templates for all worktree slots.
 */
export function generateAllTemplates(
  wtDir: string,
  containerDir: string,
  slots: Record<string, { branch: string | null }>,
  templates: TemplateConfig[]
): Promise<void>;
```

### Expansion rules
- Replace `{{WORKTREE_DIR}}` with the slot directory name.
- Replace `{{BRANCH_NAME}}` with the branch name (or empty string if detached/vacant).
- Unknown `{{...}}` patterns are left as-is (no error).

### Behavior
- `generateTemplates` creates parent directories if they don't exist.
- Always overwrites the target file (VISION Section 7.3).
- If the template source file doesn't exist, emit a warning to stderr and skip.

### Unit tests (`test/unit/templates.test.ts`)

- `expandTemplate` replaces `{{WORKTREE_DIR}}` and `{{BRANCH_NAME}}`.
- `expandTemplate` leaves unknown `{{FOO}}` variables as-is.
- `expandTemplate` handles multiple occurrences.
- `expandTemplate` handles template with no variables (passthrough).
- `generateTemplates` writes files to correct paths (use temp dir).
- `generateTemplates` creates parent directories.
- `generateTemplates` overwrites existing files.
- `generateTemplates` skips missing source files (warns, doesn't throw).

---

## 1.8 `core/git.ts`

### Purpose
Thin wrappers around git commands via `execa` (VISION Section 15.3 — errors pass through).

### Interface

```ts
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run `git fetch --all --prune` in the repo directory. */
export function fetch(repoDir: string): Promise<void>;

/** Run `git worktree add --detach <path> <commit>`. */
export function worktreeAdd(
  repoDir: string,
  worktreePath: string,
  commit: string
): Promise<void>;

/** Run `git checkout <branch>` in a worktree. */
export function checkout(worktreeDir: string, branch: string): Promise<void>;

/** Run `git checkout --detach` in a worktree. */
export function checkoutDetach(worktreeDir: string): Promise<void>;

/** Run `git stash create --include-untracked` → returns commit hash or null (clean). */
export function stashCreate(worktreeDir: string): Promise<string | null>;

/** Run `git stash apply <ref>` → returns { success, conflicted }. */
export function stashApply(
  worktreeDir: string,
  ref: string
): Promise<{ success: boolean; conflicted: boolean }>;

/** Run `git stash show -p --include-untracked <ref>`. */
export function stashShow(repoDir: string, ref: string): Promise<string>;

/** Run `git update-ref <refName> <hash>`. */
export function updateRef(
  repoDir: string,
  refName: string,
  hash: string
): Promise<void>;

/** Run `git update-ref -d <refName>`. */
export function deleteRef(repoDir: string, refName: string): Promise<void>;

/** Run `git status --porcelain` → returns raw output (empty string = clean). */
export function status(worktreeDir: string): Promise<string>;

/** Detect the symbolic name of HEAD (branch name or null if detached). */
export function currentBranch(worktreeDir: string): Promise<string | null>;

/** Detect the remote default branch (e.g., "main" or "master"). */
export function defaultBranch(repoDir: string): Promise<string>;

/** Check if a branch exists on the remote. */
export function remoteBranchExists(
  repoDir: string,
  branch: string
): Promise<boolean>;

/** List all local branches. */
export function listLocalBranches(repoDir: string): Promise<string[]>;

/** List all remote branches. */
export function listRemoteBranches(repoDir: string): Promise<string[]>;

/** Run `git worktree list --porcelain`. */
export function worktreeList(repoDir: string): Promise<Array<{
  path: string;
  head: string;
  branch: string | null;
}>>;

/** Run `git ls-files <path>` to check if a file is tracked. */
export function isTracked(worktreeDir: string, filePath: string): Promise<boolean>;

/** Run `git rev-parse --show-toplevel` to get repo root. */
export function repoRoot(dir: string): Promise<string>;

/** Clone a bare repo. */
export function cloneBare(url: string, dest: string): Promise<void>;
```

### Implementation pattern

Every function follows this pattern:
```ts
import { execa } from "execa";

export async function fetch(repoDir: string): Promise<void> {
  await execa("git", ["fetch", "--all", "--prune"], {
    cwd: repoDir,
    stdio: ["ignore", "pipe", "inherit"], // stderr passes through
  });
}
```

- `stdio: ['ignore', 'pipe', 'inherit']` — stdin ignored, stdout captured, stderr inherited (passes through to user).
- For operations where we need stdout (e.g., `stashCreate`, `currentBranch`), capture it from the result.
- For operations where we need to detect failure without crashing (e.g., `stashApply`), use `try/catch` on the execa call and inspect the exit code.
- **Never** wrap or reformat git error messages.

### Testing
- No unit tests for `core/git.ts` — it's a thin wrapper. Tested via integration tests in later phases.
- Verify it compiles and exports all functions.

---

## Phase 1 Completion Checklist

- [ ] `pnpm install` succeeds
- [ ] `pnpm build` produces `dist/cli.js`
- [ ] `pnpm test` passes all unit tests
- [ ] `core/branch-encode.ts` — encode/decode with round-trip tests
- [ ] `src/data/words.ts` — curated word list (300+ words)
- [ ] `core/words.ts` — 3-word name generator with collision avoidance
- [ ] `core/config.ts` — TOML read/write with defaults
- [ ] `core/state.ts` — TOML read/write with defaults
- [ ] `core/nav.ts` — nav file write/read/clean
- [ ] `core/templates.ts` — variable expansion + file generation
- [ ] `core/git.ts` — all function signatures implemented, compiles
- [ ] All modules export clean TypeScript interfaces
