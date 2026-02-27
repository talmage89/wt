import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { join } from "path";
import type { ContainerPaths } from "../core/container.js";
import { currentSlotName } from "../core/container.js";
import { readState, readStateSync, writeState } from "../core/state.js";
import type { State } from "../core/state.js";
import { reconcile } from "../core/reconcile.js";
import { getStash, showStash } from "../core/stash.js";
import * as git from "../core/git.js";
import { StatusDot } from "./components/StatusDot.js";
import { RelativeTime } from "./components/RelativeTime.js";
import { runCheckout } from "../commands/checkout.js";
import { handleTextEditingKeys } from "./input-helpers.js";

interface BranchEntry {
  branch: string;
  tier: "pinned" | "active" | "inactive";
  slotName?: string;
  dirty?: boolean;
  lastUsedAt?: string;
  hasStash?: boolean;
  isCurrent?: boolean;
}

type Mode = "list" | "search" | "status" | "diff" | "checking_out" | "new_branch";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

/**
 * Build a fast initial entry list from state.toml alone — no git operations.
 * Dirty status is unknown at this point (shown as clean until the full load arrives).
 */
function buildInitialEntries(state: State, currentBranch?: string | null): BranchEntry[] {
  const entries: BranchEntry[] = [];
  const activeBranches = new Set<string>();

  for (const [slotName, slot] of Object.entries(state.slots)) {
    if (slot.branch !== null) {
      activeBranches.add(slot.branch);
      entries.push({
        branch: slot.branch,
        tier: slot.pinned ? "pinned" : "active",
        slotName,
        dirty: false,
        lastUsedAt: slot.last_used_at,
        isCurrent: slot.branch === currentBranch,
      });
    }
  }

  for (const histEntry of state.branch_history) {
    if (!activeBranches.has(histEntry.branch)) {
      entries.push({
        branch: histEntry.branch,
        tier: "inactive",
        lastUsedAt: histEntry.last_checkout_at,
      });
    }
  }

  entries.sort((a, b) => {
    // Current branch always first
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return bTime - aTime;
  });

  return entries;
}

async function loadBranchData(paths: ContainerPaths, currentBranch?: string | null): Promise<BranchEntry[]> {
  let state = await readState(paths.wtDir);
  state = await reconcile(paths.wtDir, paths.container, state);

  const entries: BranchEntry[] = [];
  const activeBranches = new Set<string>();

  // Check dirty status for active slots in parallel
  const slotEntries = Object.entries(state.slots).filter(
    ([, slot]) => slot.branch !== null
  );
  const slotData = await Promise.all(
    slotEntries.map(async ([slotName, slot]) => {
      const branch = slot.branch!;
      const worktreeDir = join(paths.container, slotName);
      let dirty = false;
      try {
        const statusOut = await git.status(worktreeDir);
        dirty = statusOut.trim().length > 0;
      } catch {
        // Ignore errors — treat as clean
      }
      return { slotName, slot, branch, dirty };
    })
  );

  for (const { slotName, slot, branch, dirty } of slotData) {
    activeBranches.add(branch);
    entries.push({
      branch,
      tier: slot.pinned ? "pinned" : "active",
      slotName,
      dirty,
      lastUsedAt: slot.last_used_at,
      isCurrent: branch === currentBranch,
    });
  }

  // Track all branches already represented in entries
  const knownBranches = new Set<string>(activeBranches);

  // Inactive branches from branch_history (not in any active slot)
  for (const histEntry of state.branch_history) {
    if (activeBranches.has(histEntry.branch)) continue;
    knownBranches.add(histEntry.branch);
    let hasStash = false;
    try {
      const stash = await getStash(paths.wtDir, histEntry.branch);
      // Only mark as having stash if it's active (archived stashes are in StashPanel)
      hasStash = stash !== null && stash.status === "active";
    } catch {
      // Ignore errors
    }
    entries.push({
      branch: histEntry.branch,
      tier: "inactive",
      hasStash,
      lastUsedAt: histEntry.last_checkout_at,
    });
  }

  // Add all local branches not already covered by slots or branch_history
  try {
    const localBranches = await git.listLocalBranches(paths.repoDir);
    for (const branch of localBranches) {
      if (!knownBranches.has(branch)) {
        entries.push({ branch, tier: "inactive" });
        knownBranches.add(branch);
      }
    }
  } catch {
    // Ignore errors — degrade gracefully
  }

  // Sort: current branch always first, then by LRU recency (most recently used first).
  // Pinned entries stay in their natural LRU position — not promoted to top.
  entries.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return bTime - aTime;
  });

  return entries;
}

export function WorktreePanel({ paths, onBack }: Props) {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>("list");

  // Detect which branch the user is currently sitting in
  const [currentBranch] = useState<string | null>(() => {
    const slot = currentSlotName(process.cwd(), paths);
    if (!slot) return null;
    try {
      const state = readStateSync(paths.wtDir);
      return state.slots[slot]?.branch ?? null;
    } catch {
      return null;
    }
  });

  const [entries, setEntries] = useState<BranchEntry[]>(() => {
    try {
      return buildInitialEntries(readStateSync(paths.wtDir), currentBranch);
    } catch {
      return [];
    }
  });
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Output view (status / diff)
  const [outputContent, setOutputContent] = useState("");
  const [outputTitle, setOutputTitle] = useState("");

  // New branch creation state
  const [newBranchName, setNewBranchName] = useState("");

  // Misc
  const [error, setError] = useState<string | null>(null);
  const [checkoutBranch, setCheckoutBranch] = useState<string | null>(null);

  // Load full data on mount (git status, reconcile, local branches) — update in background
  useEffect(() => {
    loadBranchData(paths, currentBranch)
      .then((data) => {
        setEntries(data);
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for live updates every 2 seconds
  useEffect(() => {
    const id = setInterval(() => {
      loadBranchData(paths, currentBranch)
        .then((newData) => {
          setEntries((prev) =>
            JSON.stringify(prev) !== JSON.stringify(newData) ? newData : prev
          );
        })
        .catch(() => {
          // Silently ignore polling errors — don't disrupt the UI
        });
    }, 2000);

    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Filtered branches for search
  const filteredBranches = searchQuery
    ? allBranches.filter((b) =>
        b.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : allBranches;

  const reload = () => {
    setError(null);
    loadBranchData(paths, currentBranch)
      .then((data) => {
        setEntries(data);
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
  };

  const doCheckout = (branch: string) => {
    setCheckoutBranch(branch);
    setMode("checking_out");
    runCheckout({ branch, cwd: paths.container })
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        setError(`Checkout failed: ${String(err)}`);
        setMode("list");
        setCheckoutBranch(null);
      });
  };

  const doCreateBranch = (branchName: string) => {
    setCheckoutBranch(branchName);
    setMode("checking_out");
    runCheckout({ branch: branchName, create: true, cwd: paths.container })
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        setError(`Branch creation failed: ${String(err)}`);
        setMode("list");
        setCheckoutBranch(null);
      });
  };

  useInput((input, key) => {
    if (mode === "checking_out") return;

    // New branch creation mode
    if (mode === "new_branch") {
      if (key.escape) {
        setMode("list");
        setNewBranchName("");
      } else if (key.return) {
        const name = newBranchName.trim();
        if (name) doCreateBranch(name);
      } else if (handleTextEditingKeys(input, key, setNewBranchName)) {
        // Option+Backspace, Ctrl+W, Ctrl+U handled
      } else if (key.backspace || key.delete) {
        setNewBranchName((n) => n.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input.length === 1) {
        setNewBranchName((n) => n + input);
      }
      return;
    }

    // Error overlay: any key clears (q quits)
    if (error !== null) {
      if (input === "q") exit();
      else setError(null);
      return;
    }

    // Output view (status / diff)
    if (mode === "status" || mode === "diff") {
      if (key.escape) setMode("list");
      else if (input === "q") exit();
      return;
    }

    // Search mode
    if (mode === "search") {
      if (key.escape) {
        setMode("list");
        setSearchQuery("");
        setSearchIdx(0);
      } else if (key.return) {
        const branch = filteredBranches[searchIdx];
        if (branch) doCheckout(branch);
      } else if (key.upArrow || (key.ctrl && input === "p")) {
        setSearchIdx((i) => Math.max(0, i - 1));
      } else if (key.downArrow || (key.ctrl && input === "n")) {
        setSearchIdx((i) =>
          filteredBranches.length === 0
            ? 0
            : Math.min(filteredBranches.length - 1, i + 1)
        );
      } else if (handleTextEditingKeys(input, key, setSearchQuery)) {
        // Option+Backspace, Ctrl+W, Ctrl+U handled
      } else if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input.length === 1) {
        setSearchQuery((q) => q + input);
      }
      return;
    }

    // List mode
    if (key.escape) {
      onBack();
    } else if (input === "q") {
      exit();
    } else if (input === "/") {
      setMode("search");
      setSearchQuery("");
      setSearchIdx(0);
      // Lazy-load branches on first search open
      if (allBranches.length === 0 && !loadingBranches) {
        setLoadingBranches(true);
        Promise.all([
          git.listLocalBranches(paths.repoDir),
          git.listRemoteBranches(paths.repoDir),
        ])
          .then(([local, remote]) => {
            const remoteStripped = remote.map((r) => r.replace(/^origin\//, ""));
            const combined = Array.from(
              new Set([...local, ...remoteStripped])
            ).sort();
            setAllBranches(combined);
          })
          .catch(() => setAllBranches([]))
          .finally(() => setLoadingBranches(false));
      }
    } else if (input === "n" && !key.ctrl) {
      setMode("new_branch");
      setNewBranchName("");
    } else if (key.upArrow || input === "k" || (key.ctrl && input === "p")) {
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j" || (key.ctrl && input === "n")) {
      setSelectedIdx((i) =>
        entries.length === 0 ? 0 : Math.min(entries.length - 1, i + 1)
      );
    } else if (key.return) {
      const entry = entries[selectedIdx];
      if (entry) doCheckout(entry.branch);
    } else if (input === "p" && !key.ctrl) {
      const entry = entries[selectedIdx];
      if (
        entry &&
        (entry.tier === "active" || entry.tier === "pinned") &&
        entry.slotName
      ) {
        const slotName = entry.slotName;
        readState(paths.wtDir)
          .then((state) => {
            if (state.slots[slotName]) {
              state.slots[slotName].pinned = !state.slots[slotName].pinned;
              return writeState(paths.wtDir, state);
            }
          })
          .then(reload)
          .catch((err: unknown) => setError(String(err)));
      }
    } else if (input === "s") {
      const entry = entries[selectedIdx];
      if (
        entry &&
        (entry.tier === "active" || entry.tier === "pinned") &&
        entry.slotName
      ) {
        const worktreeDir = join(paths.container, entry.slotName);
        git
          .status(worktreeDir)
          .then((out) => {
            setOutputContent(out.trim() || "(clean)");
            setOutputTitle(`git status: ${entry.branch}`);
            setMode("status");
          })
          .catch((err: unknown) => setError(String(err)));
      }
    } else if (input === "d") {
      const entry = entries[selectedIdx];
      if (entry && entry.tier === "inactive" && entry.hasStash) {
        getStash(paths.wtDir, entry.branch)
          .then(async (stash) => {
            if (!stash) return;
            const diff = await showStash(paths.repoDir, stash.stash_ref);
            setOutputContent(diff.trim() || "(empty diff)");
            setOutputTitle(`stash diff: ${entry.branch}`);
            setMode("diff");
          })
          .catch((err: unknown) => setError(String(err)));
      }
    }
  });

  // --- Render ---

  if (mode === "checking_out") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Manage Worktrees</Text>
        <Box marginTop={1}>
          <Text>Checking out </Text>
          <Text bold>{checkoutBranch}</Text>
          <Text>...</Text>
        </Box>
      </Box>
    );
  }

  if (error !== null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Manage Worktrees</Text>
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press any key to continue, q to quit</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "status" || mode === "diff") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>{outputTitle}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{outputContent}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc: back  q: quit</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "search") {
    const SEARCH_VISIBLE = 20;
    let searchViewStart = 0;
    if (filteredBranches.length > SEARCH_VISIBLE) {
      searchViewStart = Math.min(
        Math.max(0, searchIdx - Math.floor(SEARCH_VISIBLE / 2)),
        filteredBranches.length - SEARCH_VISIBLE,
      );
    }
    const searchViewEnd = Math.min(searchViewStart + SEARCH_VISIBLE, filteredBranches.length);

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Branch Search</Text>
        <Box marginTop={1}>
          <Text bold color="green">
            /{" "}
          </Text>
          <Text>{searchQuery}</Text>
          <Text color="cyan">█</Text>
        </Box>
        {loadingBranches && (
          <Box marginTop={1}>
            <Text dimColor>Loading branches...</Text>
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {filteredBranches.length === 0 && !loadingBranches ? (
            <Text dimColor>
              No branches match &quot;{searchQuery}&quot;
            </Text>
          ) : (
            <>
              {searchViewStart > 0 && (
                <Text dimColor>  ↑ {searchViewStart} more</Text>
              )}
              {filteredBranches.slice(searchViewStart, searchViewEnd).map((branch, vi) => {
                const i = searchViewStart + vi;
                return (
                  <Box key={branch}>
                    <Text color={i === searchIdx ? "cyan" : undefined} bold={i === searchIdx}>
                      {i === searchIdx ? "› " : "  "}
                      {branch}
                    </Text>
                  </Box>
                );
              })}
              {searchViewEnd < filteredBranches.length && (
                <Text dimColor>  ↓ {filteredBranches.length - searchViewEnd} more</Text>
              )}
            </>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑/↓/^n/^p: navigate  Enter: checkout  Esc: close
          </Text>
        </Box>
      </Box>
    );
  }

  if (mode === "new_branch") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>New Branch</Text>
        <Box marginTop={1}>
          <Text bold color="green">name: </Text>
          <Text>{newBranchName}</Text>
          <Text color="cyan">█</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Creates from origin/&lt;default-branch&gt;</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter: create  Esc: cancel</Text>
        </Box>
      </Box>
    );
  }

  // List mode
  const currentEntry = entries[selectedIdx];

  // Viewport: show at most MAX_VISIBLE rows, sliding window around selectedIdx
  const MAX_VISIBLE = 25;
  let viewStart = 0;
  if (entries.length > MAX_VISIBLE) {
    // Keep selected item roughly centered, clamped to bounds
    viewStart = Math.min(
      Math.max(0, selectedIdx - Math.floor(MAX_VISIBLE / 2)),
      entries.length - MAX_VISIBLE
    );
  }
  const viewEnd = Math.min(viewStart + MAX_VISIBLE, entries.length);
  const visibleEntries = entries.slice(viewStart, viewEnd);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Manage Worktrees</Text>
      <Box marginTop={1} flexDirection="column">
        {entries.length === 0 ? (
          <Text dimColor>
            No worktrees. Use &quot;wt checkout &lt;branch&gt;&quot; to get started.
          </Text>
        ) : (
          <>
            {viewStart > 0 && (
              <Text dimColor>  ↑ {viewStart} more</Text>
            )}
            {visibleEntries.map((entry, vi) => {
              const i = viewStart + vi;
              const isSelected = i === selectedIdx;
              return (
                <Box key={entry.branch}>
                  <Text color={isSelected ? "cyan" : undefined}>
                    {isSelected ? "› " : "  "}
                  </Text>
                  {entry.isCurrent && <Text color="green">* </Text>}
                  {entry.tier === "pinned" && <Text>📌 </Text>}
                  {(entry.tier === "pinned" || entry.tier === "active") && (
                    <StatusDot dirty={entry.dirty ?? false} />
                  )}
                  <Text
                    bold={isSelected}
                    color={
                      isSelected
                        ? "cyan"
                        : entry.tier === "inactive"
                        ? undefined
                        : "white"
                    }
                    dimColor={entry.tier === "inactive" && !isSelected}
                  >
                    {" "}
                    {entry.branch}
                  </Text>
                  {entry.slotName && (
                    <Text dimColor>  {entry.slotName}</Text>
                  )}
                  {entry.lastUsedAt && (
                    <>
                      <Text dimColor>  </Text>
                      <RelativeTime isoDate={entry.lastUsedAt} dimColor />
                    </>
                  )}
                  {entry.hasStash && (
                    <Text color="yellow">  [stash]</Text>
                  )}
                </Box>
              );
            })}
            {viewEnd < entries.length && (
              <Text dimColor>  ↓ {entries.length - viewEnd} more</Text>
            )}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        {!currentEntry ? (
          <Text dimColor>n: new branch  /: search  Esc: back  q: quit</Text>
        ) : currentEntry.tier === "inactive" ? (
          <Text dimColor>
            Enter: checkout
            {currentEntry.hasStash ? "  d: stash diff" : ""}
            {"  n: new branch  /: search  Esc: back  q: quit"}
          </Text>
        ) : (
          <Text dimColor>
            Enter: checkout  p: pin/unpin  s: git status  n: new branch  /: search  Esc: back  q: quit
          </Text>
        )}
      </Box>
    </Box>
  );
}
