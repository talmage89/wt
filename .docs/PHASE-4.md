# Phase 4: Symlinks & Templates (Full)

**Goal**: `wt sync` fully operational. Shared symlink management and template regeneration work across all worktree slots.

**Depends on**: Phase 3 (checkout flow, which already calls basic symlink/template functions).

---

## 4.1 `core/symlinks.ts`

### Purpose
Manage shared symlinks across worktrees (VISION Section 6). Canonical files live in `.wt/shared/`, and each worktree gets symlinks pointing to them.

### Interface

```ts
/**
 * Establish symlinks for a single worktree slot.
 * For each configured shared directory, for each file in `.wt/shared/<dir>/`:
 *   - If the file is git-tracked in this worktree's branch: skip, warn.
 *   - If a real file (not symlink) exists at the target: leave it (sync handles migration).
 *   - If no file exists at the target: create the symlink.
 *   - If a symlink exists but points elsewhere: fix it.
 *   - If a symlink exists and is correct: skip.
 */
export async function establishSymlinks(
  wtDir: string,
  worktreeDir: string,
  sharedDirs: string[],
  branch: string
): Promise<void>;

/**
 * Full sync across all worktrees.
 * For each configured shared directory, for each worktree slot:
 *   1. If a real file exists in the worktree (not symlink, not git-tracked):
 *      Move it to `.wt/shared/` and replace with symlink.
 *   2. If a file exists in `.wt/shared/` but worktree lacks the symlink:
 *      Create the symlink (respecting git-tracked precedence).
 *   3. If a symlink is broken (target deleted): remove it.
 */
export async function syncAllSymlinks(
  wtDir: string,
  containerDir: string,
  slots: Record<string, { branch: string | null }>,
  sharedDirs: string[]
): Promise<void>;

/**
 * Check if a file path is tracked by git in the given worktree.
 */
export async function isGitTracked(
  worktreeDir: string,
  relativePath: string
): Promise<boolean>;

/**
 * Remove all shared symlinks from a worktree (used during cleanup).
 */
export async function removeSymlinks(
  wtDir: string,
  worktreeDir: string,
  sharedDirs: string[]
): Promise<void>;
```

### `establishSymlinks` detail

For a single worktree:

```
for each sharedDir in sharedDirs:
  canonicalDir = path.join(wtDir, "shared", sharedDir)
  if (!exists(canonicalDir)) continue  // nothing to link

  // Walk all files recursively in canonicalDir
  for each file (relative to canonicalDir):
    targetPath = path.join(worktreeDir, sharedDir, file)
    canonicalPath = path.join(canonicalDir, file)
    relativeLinkTarget = path.relative(path.dirname(targetPath), canonicalPath)

    // Check git-tracked conflict
    relativeToWorktree = path.join(sharedDir, file)
    if (await isGitTracked(worktreeDir, relativeToWorktree)):
      console.error(`Skipping symlink for ${relativeToWorktree}: file is tracked by git in branch ${branch}.`)
      continue

    // Check current state at targetPath
    const stat = await lstat(targetPath).catch(() => null)

    if (stat === null):
      // No file — create parent dirs and symlink
      await mkdir(path.dirname(targetPath), { recursive: true })
      await symlink(relativeLinkTarget, targetPath)

    else if (stat.isSymbolicLink()):
      // Check if it points to the right place
      const current = await readlink(targetPath)
      if (current !== relativeLinkTarget):
        await rm(targetPath)
        await symlink(relativeLinkTarget, targetPath)
      // else: already correct, skip

    else:
      // Real file exists — don't touch it (sync will handle migration)
      // This can happen if the user created a file before running sync.
      continue
```

### `syncAllSymlinks` detail

For all worktrees:

```
for each sharedDir in sharedDirs:
  canonicalDir = path.join(wtDir, "shared", sharedDir)

  for each slotName, slotState in slots:
    worktreeDir = path.join(containerDir, slotName)
    worktreeSharedDir = path.join(worktreeDir, sharedDir)

    if (!exists(worktreeSharedDir)) continue to file check

    // STEP 1: Migrate real files to canonical location
    // Walk all real files (not symlinks) in worktreeSharedDir
    for each file in worktreeSharedDir (recursive):
      fullPath = path.join(worktreeSharedDir, file)
      stat = await lstat(fullPath)

      if (stat.isSymbolicLink()) continue  // already a symlink
      if (stat.isFile()):
        relativeToWorktree = path.join(sharedDir, file)
        if (await isGitTracked(worktreeDir, relativeToWorktree)) continue  // git-tracked, don't move

        // Move to canonical
        canonicalPath = path.join(canonicalDir, file)
        await mkdir(path.dirname(canonicalPath), { recursive: true })

        // If canonical already exists, the worktree file is stale; overwrite? or skip?
        // Policy: first file wins. If canonical exists, replace worktree file with symlink.
        if (!exists(canonicalPath)):
          await rename(fullPath, canonicalPath)  // move to canonical
        else:
          await rm(fullPath)  // canonical already has the file

        // Create symlink
        relativeLinkTarget = path.relative(path.dirname(fullPath), canonicalPath)
        await symlink(relativeLinkTarget, fullPath)

  // STEP 2: Propagate canonical files to all worktrees
  for each slotName, slotState in slots:
    branch = slotState.branch ?? "(detached)"
    worktreeDir = path.join(containerDir, slotName)
    await establishSymlinks(wtDir, worktreeDir, [sharedDir], branch)

  // STEP 3: Clean broken symlinks in all worktrees
  for each slotName in slots:
    worktreeDir = path.join(containerDir, slotName)
    worktreeSharedDir = path.join(worktreeDir, sharedDir)
    if (!exists(worktreeSharedDir)) continue

    for each file in worktreeSharedDir (recursive):
      fullPath = path.join(worktreeSharedDir, file)
      stat = await lstat(fullPath)
      if (stat.isSymbolicLink()):
        try:
          await access(fullPath)  // follows symlink — if target missing, throws
        catch:
          await rm(fullPath)  // broken symlink
```

### `isGitTracked` implementation

```ts
export async function isGitTracked(worktreeDir: string, relativePath: string): Promise<boolean> {
  return git.isTracked(worktreeDir, relativePath);
}
```

Which calls `git ls-files <path>` — if output is non-empty, the file is tracked.

### Symlink path calculation

Symlinks must use **relative paths** so they work regardless of where the container is mounted. The symlink from `container/slot/.claude/CLAUDE.md` to `container/.wt/shared/.claude/CLAUDE.md` uses:

```
../../.wt/shared/.claude/CLAUDE.md
```

Computed via `path.relative(path.dirname(targetPath), canonicalPath)`.

---

## 4.2 `commands/sync.ts`

### Purpose
Implement `wt sync` (VISION Sections 6.4, 7.4).

### Interface

```ts
export async function runSync(): Promise<void>;
```

### Flow

```
1. Find container
   paths = findContainer(cwd)
   if (!paths) → error

2. Read state + config
   state = readState(paths.wtDir)
   config = readConfig(paths.wtDir)

3. Reconcile
   state = reconcile(paths.wtDir, paths.container, state)

4. Sync all symlinks
   syncAllSymlinks(paths.wtDir, paths.container, state.slots, config.shared.directories)

5. Regenerate all templates
   generateAllTemplates(paths.wtDir, paths.container, state.slots, config.templates)
```

### CLI wiring

Replace the `sync` stub in `src/cli.ts`:

```ts
.command(
  "sync",
  "Propagate shared symlinks and regenerate template files",
  () => {},
  async () => { await runSync(); }
)
```

---

## 4.3 Integration with Checkout

Phase 3 already calls `establishSymlinks` and `generateTemplates` during checkout (steps 8-9 of the checkout flow). This phase upgrades those calls to use the full implementation. No changes needed to `commands/checkout.ts` — just the underlying `core/symlinks.ts` is now complete.

---

## 4.4 Integration Tests

### `test/integration/symlinks.test.ts`

**Test: establish symlinks in a worktree**
1. Set up: init container, create `.wt/shared/.claude/settings.json` with content.
2. Run `establishSymlinks` on one slot with `sharedDirs: [".claude"]`.
3. Verify: `<slot>/.claude/settings.json` is a symlink pointing to `../../.wt/shared/.claude/settings.json`.
4. Verify: reading the symlink returns the canonical file's content.
5. Verify: writing through the symlink updates the canonical file.

**Test: git-tracked file takes precedence**
1. Set up: init container, checkout a branch that has `.claude/CLAUDE.md` tracked in git.
2. Also have `.wt/shared/.claude/CLAUDE.md`.
3. Run `establishSymlinks`.
4. Verify: `.claude/CLAUDE.md` is NOT a symlink — it's the git-tracked version.
5. Verify: warning was emitted to stderr.

**Test: sync migrates real files to canonical location**
1. Set up: init container. In slot X, manually create `.claude/settings.json` as a real file (not symlink, not git-tracked).
2. Run `syncAllSymlinks`.
3. Verify: `.wt/shared/.claude/settings.json` now exists with the file's content.
4. Verify: `<slotX>/.claude/settings.json` is now a symlink.
5. Verify: all other slots also have the symlink.

**Test: sync creates missing symlinks**
1. Set up: init container, create canonical file in `.wt/shared/`.
2. Run `syncAllSymlinks`.
3. Verify: all slots have symlinks.

**Test: sync cleans broken symlinks**
1. Set up: init container, establish symlinks, then delete the canonical file.
2. Run `syncAllSymlinks`.
3. Verify: broken symlinks are removed from all slots.

**Test: sync with empty shared config**
1. Set up: init with `shared.directories = []`.
2. Run `syncAllSymlinks`.
3. Verify: no-op, no errors.

**Test: template regeneration via sync**
1. Set up: init with a template config. Checkout branch A in a slot.
2. Modify the template source file.
3. Run `runSync()`.
4. Verify: generated file in all slots reflects new template content.
5. Verify: `{{BRANCH_NAME}}` is expanded correctly per slot.

**Test: checkout reconciles symlinks**
1. Set up: init container, configure shared dirs.
2. Add a file to `.wt/shared/` after init.
3. Run `wt checkout <branch>`.
4. Verify: the target slot gets the new symlink.

---

## Phase 4 Completion Checklist

- [ ] `core/symlinks.ts` — `establishSymlinks`, `syncAllSymlinks`, `isGitTracked`, `removeSymlinks`
- [ ] `commands/sync.ts` — full sync flow
- [ ] CLI wiring — `wt sync` works
- [ ] Symlinks use relative paths
- [ ] Git-tracked file precedence respected with warning
- [ ] Sync migrates real files to canonical location
- [ ] Broken symlinks cleaned
- [ ] Template regeneration works via sync
- [ ] Checkout flow uses full symlink implementation
- [ ] Integration tests: all symlink scenarios passing
- [ ] Integration tests: template + symlink combined scenarios
