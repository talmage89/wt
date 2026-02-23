# Phase 7: TUI

**Goal**: `wt` (no arguments) opens a fullscreen TUI built with Ink (React for CLI). All four panels from VISION Section 8 are implemented.

**Depends on**: Phase 6 (all core features complete — the TUI is a frontend over the existing core modules).

---

## 7.1 Dependencies

Install TUI-specific packages:

```
pnpm add ink react ink-text-input ink-select-input ink-spinner
pnpm add -D @types/react
```

### tsconfig additions
Add JSX support:
```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

### tsup additions
Configure tsup to handle `.tsx` files.

---

## 7.2 TUI Entry Point

### `src/tui/App.tsx`

Root component. Manages top-level navigation between panels.

```tsx
import React, { useState } from "react";
import { Box } from "ink";
import { MainMenu } from "./MainMenu.js";
import { WorktreePanel } from "./WorktreePanel.js";
import { StashPanel } from "./StashPanel.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { TemplatePanel } from "./TemplatePanel.js";

type Screen = "menu" | "worktrees" | "stashes" | "config" | "templates";

interface AppProps {
  containerPaths: ContainerPaths;
}

export function App({ containerPaths }: AppProps) {
  const [screen, setScreen] = useState<Screen>("menu");

  switch (screen) {
    case "menu":
      return <MainMenu onSelect={setScreen} />;
    case "worktrees":
      return <WorktreePanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    case "stashes":
      return <StashPanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    case "config":
      return <ConfigPanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    case "templates":
      return <TemplatePanel paths={containerPaths} onBack={() => setScreen("menu")} />;
  }
}
```

### Launching the TUI from CLI

In `src/cli.ts`, when no command is given:

```ts
// At the end of yargs setup, if no command matched:
if (process.argv.length <= 2) {
  // No command — launch TUI or show help
  const paths = await findContainer(process.cwd());
  if (paths) {
    const { render } = await import("ink");
    const React = await import("react");
    const { App } = await import("./tui/App.js");
    render(React.createElement(App, { containerPaths: paths }));
  } else {
    cli.showHelp();
  }
}
```

---

## 7.3 `MainMenu.tsx`

Simple vertical list of 4 actions (VISION Section 8.1).

```tsx
import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";

const items = [
  { label: "Manage Worktrees", value: "worktrees" },
  { label: "Manage Stashes", value: "stashes" },
  { label: "Edit Configuration", value: "config" },
  { label: "Edit Templates", value: "templates" },
];

interface Props {
  onSelect: (screen: string) => void;
}

export function MainMenu({ onSelect }: Props) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>wt — Git Worktree Control Plane</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={(item) => onSelect(item.value)} />
      </Box>
    </Box>
  );
}
```

---

## 7.4 `WorktreePanel.tsx`

The most complex panel. Branch-centric view (VISION Section 8.2).

### Data model

```ts
interface BranchEntry {
  branch: string;
  tier: "pinned" | "active" | "inactive";
  slotName?: string;        // only for pinned/active
  dirty?: boolean;          // only for pinned/active
  lastUsedAt?: string;
  hasStash?: boolean;       // only for inactive
}
```

### Building the branch list

```
1. Read state + reconcile
2. For each slot in state.slots where branch !== null:
   - If pinned → tier = "pinned"
   - Else → tier = "active"
   - dirty = (await git.status(worktreeDir)).length > 0
   - slotName, lastUsedAt from state
3. For each entry in state.branch_history where branch NOT in any slot:
   - tier = "inactive"
   - hasStash = (await getStash(wtDir, branch)) !== null
   - lastUsedAt from branch_history entry
4. Sort:
   - Pinned first (sorted by recency among themselves)
   - Active next (sorted by recency)
   - Inactive last (sorted by recency)
```

### Display

Each entry shows:

**Pinned/Active:**
```
📌 ● feature/auth          crimson-maple-river  2m ago
   ● main                  gentle-autumn-spark  5h ago
   ● fix/login             bright-coral-dawn    1d ago
```
- Pin indicator (📌) only for pinned
- Green/yellow dot (● in green or yellow)
- Branch name in bright white
- Slot name in dim
- Relative time

**Inactive:**
```
   feature/old-branch     [stash]              3d ago
   experiment/test                              7d ago
```
- Dim text
- `[stash]` marker if stash exists
- Relative time

### Actions

When an entry is focused, show available actions at the bottom:

**Active/Pinned branch:**
- `Enter` — Checkout (navigate to this worktree)
- `p` — Pin/Unpin toggle
- `s` — View git status

**Inactive branch:**
- `Enter` — Checkout (triggers slot selection/eviction)
- `d` — View stash diff (if stash exists)

### Branch search

- `/` opens a search input
- Fuzzy search across all local + remote branches (via `git.listLocalBranches` + `git.listRemoteBranches`)
- Results displayed as a filtered list
- `Enter` on a result triggers checkout
- `Esc` closes search

### Checkout from TUI

When the user selects a branch for checkout:
1. The TUI calls `runCheckout({ branch })` from `commands/checkout.ts`.
2. On completion, the TUI writes a nav file and exits.
3. The shell function picks up the nav file and `cd`s.

This means the TUI must **exit** after checkout to allow the shell function to navigate. Use `process.exit(0)` after writing the nav file.

### Hooks

The TUI uses React hooks for data loading:

```tsx
function useWorktreeData(paths: ContainerPaths) {
  const [data, setData] = useState<BranchEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData().then(setData).finally(() => setLoading(false));
  }, []);

  return { data, loading };
}
```

---

## 7.5 `StashPanel.tsx`

Displays all stashes grouped by status (VISION Section 8.3).

### Display

```
Active Stashes:
  feature/my-branch    2h ago     abc1234
  fix/login-bug        3d ago     def5678

Archived Stashes:
  old/feature          15d ago    2.3 KB
  experiment/test      30d ago    1.1 KB
```

### Actions

- `a` — Apply stash (prompts if branch not in a slot)
- `d` — View diff
- `x` — Delete (with confirmation)
- `X` — Bulk delete mode (toggle checkboxes, then confirm)

### Apply workflow

If branch is in an active slot:
1. `restoreStash` directly.
2. Show result.

If branch is NOT in a slot:
1. Prompt: "Branch is not checked out. Check it out first? [y/N]"
2. If yes: `runCheckout` → write nav file → exit TUI.

---

## 7.6 `ConfigPanel.tsx`

Opens `.wt/config.toml` in an in-terminal editor (VISION Section 8.4).

### Implementation options

1. **Launch `$EDITOR`**: Use `execa` to launch the user's preferred editor (`$EDITOR` or `vi`). The TUI pauses (Ink unmounts), the editor takes over the terminal, then Ink remounts when done.

2. **Built-in text editor**: Implement a basic text area using Ink components. Very limited.

**Chosen approach**: Launch `$EDITOR`. This is standard practice for CLI tools (git commit, kubectl edit, etc.).

```tsx
import { useApp } from "ink";

function ConfigPanel({ paths, onBack }) {
  const { exit } = useApp();

  useEffect(() => {
    const editor = process.env.EDITOR || "vi";
    const configPath = path.join(paths.wtDir, "config.toml");

    // Temporarily unmount Ink, launch editor, remount
    const child = spawn(editor, [configPath], { stdio: "inherit" });
    child.on("exit", () => {
      onBack(); // return to menu
    });
  }, []);

  return <Text>Opening editor...</Text>;
}
```

**Note**: Ink doesn't natively support pausing/resuming. The recommended approach is to use `useStdin` to pause raw mode, then spawn the editor. See Ink documentation for details.

---

## 7.7 `TemplatePanel.tsx`

Lists template source files, allows editing and regeneration (VISION Section 8.5).

### Display

```
Template Files:
  1. templates/.env.development → .env.development
  2. templates/docker-compose.override.yml → docker-compose.override.yml

Select a template to edit, or [r] to regenerate all.
```

### Actions

- `Enter` on a template → Launch `$EDITOR` on the source file
- After editing, prompt: "Regenerate this template across all worktrees? [y/N]"
- `r` — Regenerate all templates across all worktrees (without editing)

### Regeneration

Calls `generateAllTemplates()` from `core/templates.ts`.

---

## 7.8 Shared TUI Components

### `components/StatusDot.tsx`

```tsx
import React from "react";
import { Text } from "ink";

export function StatusDot({ dirty }: { dirty: boolean }) {
  return <Text color={dirty ? "yellow" : "green"}>●</Text>;
}
```

### `components/BranchList.tsx`

Reusable list component with keyboard navigation, search, and action dispatch.

### `components/Confirm.tsx`

Simple yes/no confirmation prompt.

### `components/RelativeTime.tsx`

Displays a relative timestamp.

---

## 7.9 Keybindings Summary

| Key | Context | Action |
|---|---|---|
| `↑`/`↓` or `j`/`k` | All lists | Navigate |
| `Enter` | All lists | Select/activate |
| `Esc` | Subpanels | Back to menu |
| `q` | Anywhere | Quit TUI |
| `/` | Worktree panel | Open branch search |
| `p` | Worktree panel (active branch) | Toggle pin |
| `s` | Worktree panel (active branch) | View git status |
| `d` | Stash panel | View stash diff |
| `a` | Stash panel | Apply stash |
| `x` | Stash panel | Delete stash |
| `X` | Stash panel | Bulk delete mode |
| `r` | Template panel | Regenerate all |

---

## 7.10 Testing Strategy

TUI testing is notoriously difficult. Strategy:

1. **Component unit tests**: Use `ink-testing-library` to render components and assert output.
2. **Data loading logic**: Extract data-fetching hooks into pure functions that can be unit-tested without Ink.
3. **Integration tests**: Minimal — verify TUI launches without crashing, renders main menu.

### Example test with `ink-testing-library`

```ts
import { render } from "ink-testing-library";
import { MainMenu } from "../src/tui/MainMenu.js";

test("renders main menu items", () => {
  const { lastFrame } = render(<MainMenu onSelect={() => {}} />);
  expect(lastFrame()).toContain("Manage Worktrees");
  expect(lastFrame()).toContain("Manage Stashes");
  expect(lastFrame()).toContain("Edit Configuration");
  expect(lastFrame()).toContain("Edit Templates");
});
```

---

## Phase 7 Completion Checklist

- [ ] Ink + React dependencies installed and configured
- [ ] `App.tsx` — root component with screen navigation
- [ ] `MainMenu.tsx` — 4-item menu
- [ ] `WorktreePanel.tsx` — branch-centric list with 3 tiers
- [ ] Branch search (fuzzy, all local+remote branches)
- [ ] Status dots (green/yellow)
- [ ] Pin indicators
- [ ] Relative timestamps
- [ ] Stash indicators for inactive branches
- [ ] Checkout from TUI (exits + nav file)
- [ ] `StashPanel.tsx` — grouped stash list with actions
- [ ] `ConfigPanel.tsx` — launch $EDITOR
- [ ] `TemplatePanel.tsx` — list, edit, regenerate
- [ ] Shared components (StatusDot, Confirm, etc.)
- [ ] Keybindings working
- [ ] TUI launches from `wt` with no args (inside container)
- [ ] `wt` with no args outside container → shows help
- [ ] Basic TUI tests with ink-testing-library
