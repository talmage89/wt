import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { runCheckout } from "../commands/checkout.js";
import type { ContainerPaths } from "../core/container.js";
import type { StashMetadata } from "../core/stash.js";
import { dropStash, listStashes, restoreStash, showStash } from "../core/stash.js";
import { readState } from "../core/state.js";
import { RelativeTime } from "./components/RelativeTime.js";

type Mode = "list" | "diff" | "confirm_delete" | "bulk_delete" | "applying" | "confirm_checkout";

interface StashEntry {
  meta: StashMetadata;
  archiveSizeKb?: number; // only for archived stashes with archive_path
}

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

async function loadStashData(
  paths: ContainerPaths,
): Promise<{ active: StashEntry[]; archived: StashEntry[] }> {
  const stashes = await listStashes(paths.wtDir);

  const active: StashEntry[] = [];
  const archived: StashEntry[] = [];

  for (const meta of stashes) {
    if (meta.status === "archived") {
      let archiveSizeKb: number | undefined;
      if (meta.archive_path) {
        try {
          const s = await stat(meta.archive_path);
          archiveSizeKb = Math.round(s.size / 1024);
        } catch {
          // Ignore — file may be missing
        }
      }
      archived.push({ meta, archiveSizeKb });
    } else {
      active.push({ meta });
    }
  }

  // Sort each group by last_used_at descending (most recent first)
  const byRecency = (a: StashEntry, b: StashEntry) =>
    new Date(b.meta.last_used_at).getTime() - new Date(a.meta.last_used_at).getTime();
  active.sort(byRecency);
  archived.sort(byRecency);

  return { active, archived };
}

/** Flat list of all entries in display order: active first, then archived. */
function flattenEntries(groups: { active: StashEntry[]; archived: StashEntry[] }): StashEntry[] {
  return [...groups.active, ...groups.archived];
}

export function StashPanel({ paths, onBack }: Props) {
  const { exit } = useApp();

  const [mode, setMode] = useState<Mode>("list");
  const [groups, setGroups] = useState<{
    active: StashEntry[];
    archived: StashEntry[];
  }>({ active: [], archived: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Bulk delete selection
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());

  // Output view for diff
  const [diffContent, setDiffContent] = useState("");
  const [diffTitle, setDiffTitle] = useState("");

  // Confirm delete target
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Checkout-before-apply state
  const [applyBranch, setApplyBranch] = useState<string | null>(null);

  const allEntries = flattenEntries(groups);

  const reload = () => {
    setLoading(true);
    setError(null);
    loadStashData(paths)
      .then((g) => {
        setGroups(g);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(String(err));
        setLoading(false);
      });
  };

  useEffect(() => {
    reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for live updates every 2 seconds (starts after initial load)
  useEffect(() => {
    if (loading) return;

    const id = setInterval(() => {
      loadStashData(paths)
        .then((newGroups) => {
          setGroups((prev) =>
            JSON.stringify(prev) !== JSON.stringify(newGroups) ? newGroups : prev,
          );
        })
        .catch(() => {
          // Silently ignore polling errors — don't disrupt the UI
        });
    }, 2000);

    return () => clearInterval(id);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentEntry = allEntries[selectedIdx];

  const doApply = async (branch: string) => {
    // Check if branch is in an active slot
    const state = await readState(paths.wtDir);
    const slotForBranch = Object.entries(state.slots).find(([, s]) => s.branch === branch);

    if (slotForBranch) {
      // Branch is in an active slot — apply directly
      const [slotName] = slotForBranch;
      const worktreeDir = join(paths.container, slotName);
      setMode("applying");
      try {
        await restoreStash(paths.wtDir, paths.repoDir, branch, worktreeDir);
        reload();
        setMode("list");
      } catch (err: unknown) {
        setError(`Apply failed: ${String(err)}`);
        setMode("list");
      }
    } else {
      // Branch not in an active slot — prompt to checkout first
      setApplyBranch(branch);
      setMode("confirm_checkout");
    }
  };

  useInput((input, key) => {
    if (mode === "applying") return;

    // Error overlay
    if (error !== null) {
      if (input === "q") exit();
      else setError(null);
      return;
    }

    // Diff view
    if (mode === "diff") {
      if (key.escape) setMode("list");
      else if (input === "q") exit();
      return;
    }

    // Confirm delete
    if (mode === "confirm_delete") {
      if (input === "y" || input === "Y") {
        if (deleteTarget) {
          dropStash(paths.wtDir, paths.repoDir, deleteTarget)
            .then(() => {
              setDeleteTarget(null);
              setMode("list");
              reload();
            })
            .catch((err: unknown) => {
              setError(String(err));
              setDeleteTarget(null);
              setMode("list");
            });
        }
      } else {
        setDeleteTarget(null);
        setMode("list");
      }
      return;
    }

    // Confirm checkout before apply
    if (mode === "confirm_checkout") {
      if (input === "y" || input === "Y") {
        const branch = applyBranch!;
        setApplyBranch(null);
        setMode("applying");
        runCheckout({ branch, cwd: paths.container })
          .then(() => {
            process.exit(0);
          })
          .catch((err: unknown) => {
            setError(`Checkout failed: ${String(err)}`);
            setMode("list");
          });
      } else {
        setApplyBranch(null);
        setMode("list");
      }
      return;
    }

    // Bulk delete mode
    if (mode === "bulk_delete") {
      if (key.escape) {
        setMode("list");
        setBulkSelected(new Set());
      } else if (input === "q") {
        exit();
      } else if (key.upArrow || input === "k" || (key.ctrl && input === "p")) {
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (key.downArrow || input === "j" || (key.ctrl && input === "n")) {
        setSelectedIdx((i) =>
          allEntries.length === 0 ? 0 : Math.min(allEntries.length - 1, i + 1),
        );
      } else if (input === " ") {
        // Toggle selection
        if (currentEntry) {
          const branch = currentEntry.meta.branch;
          setBulkSelected((prev) => {
            const next = new Set(prev);
            if (next.has(branch)) next.delete(branch);
            else next.add(branch);
            return next;
          });
        }
      } else if (key.return) {
        // Confirm bulk delete
        const branches = Array.from(bulkSelected);
        if (branches.length === 0) {
          setMode("list");
          setBulkSelected(new Set());
          return;
        }
        Promise.all(branches.map((b) => dropStash(paths.wtDir, paths.repoDir, b)))
          .then(() => {
            setBulkSelected(new Set());
            setMode("list");
            reload();
          })
          .catch((err: unknown) => {
            setError(String(err));
            setBulkSelected(new Set());
            setMode("list");
          });
      }
      return;
    }

    // List mode
    if (key.escape) {
      onBack();
    } else if (input === "q") {
      exit();
    } else if (key.upArrow || input === "k" || (key.ctrl && input === "p")) {
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j" || (key.ctrl && input === "n")) {
      setSelectedIdx((i) => (allEntries.length === 0 ? 0 : Math.min(allEntries.length - 1, i + 1)));
    } else if (input === "a") {
      // Apply stash
      if (currentEntry) {
        doApply(currentEntry.meta.branch).catch((err: unknown) => {
          setError(String(err));
          setMode("list");
        });
      }
    } else if (input === "d") {
      // View diff
      if (currentEntry && currentEntry.meta.status === "active") {
        showStash(paths.repoDir, currentEntry.meta.stash_ref)
          .then((diff) => {
            setDiffContent(diff.trim() || "(empty diff)");
            setDiffTitle(`stash diff: ${currentEntry.meta.branch}`);
            setMode("diff");
          })
          .catch((err: unknown) => setError(String(err)));
      }
    } else if (input === "x") {
      // Delete with confirmation
      if (currentEntry) {
        setDeleteTarget(currentEntry.meta.branch);
        setMode("confirm_delete");
      }
    } else if (input === "X") {
      // Enter bulk delete mode
      if (allEntries.length > 0) {
        setBulkSelected(new Set());
        setMode("bulk_delete");
      }
    }
  });

  // --- Render ---

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Manage Stashes</Text>
        <Box marginTop={1}>
          <Text dimColor>Loading...</Text>
        </Box>
      </Box>
    );
  }

  if (error !== null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Manage Stashes</Text>
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press any key to continue, q to quit</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "diff") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>{diffTitle}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{diffContent}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Esc: back q: quit</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "applying") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Manage Stashes</Text>
        <Box marginTop={1}>
          <Text>Applying stash...</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "confirm_delete") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Manage Stashes</Text>
        <Box marginTop={1}>
          <Text>
            Delete stash for{" "}
            <Text bold color="yellow">
              {deleteTarget}
            </Text>
            ? [y/N]
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>y: yes any other key: cancel</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "confirm_checkout") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Manage Stashes</Text>
        <Box marginTop={1}>
          <Text>
            Branch{" "}
            <Text bold color="yellow">
              {applyBranch}
            </Text>{" "}
            is not checked out. Check it out to apply the stash? [y/N]
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>y: yes (will navigate to branch) any other key: cancel</Text>
        </Box>
      </Box>
    );
  }

  // List + bulk_delete modes share the same list rendering
  const isBulk = mode === "bulk_delete";

  const renderStashEntry = (entry: StashEntry, globalIdx: number) => {
    const isSelected = globalIdx === selectedIdx;
    const isChecked = bulkSelected.has(entry.meta.branch);

    return (
      <Box key={entry.meta.branch}>
        <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "› " : "  "}</Text>
        {isBulk && (
          <Text color={isChecked ? "yellow" : "white"}>{isChecked ? "[✓] " : "[ ] "}</Text>
        )}
        <Text bold={isSelected} color={isSelected ? "cyan" : undefined}>
          {entry.meta.branch}
        </Text>
        <Text dimColor> </Text>
        <RelativeTime isoDate={entry.meta.last_used_at} dimColor />
        {entry.meta.status === "archived" && entry.archiveSizeKb !== undefined && (
          <Text dimColor> {entry.archiveSizeKb} KB</Text>
        )}
        {entry.meta.status === "archived" && <Text color="yellow"> [archived]</Text>}
        {entry.meta.commit && <Text dimColor> {entry.meta.commit.slice(0, 7)}</Text>}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Manage Stashes</Text>

      {allEntries.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No stashes.</Text>
        </Box>
      ) : (
        (() => {
          // Viewport: show at most MAX_VISIBLE rows, sliding around selectedIdx
          const MAX_VISIBLE = 25;
          let viewStart = 0;
          if (allEntries.length > MAX_VISIBLE) {
            viewStart = Math.min(
              Math.max(0, selectedIdx - Math.floor(MAX_VISIBLE / 2)),
              allEntries.length - MAX_VISIBLE,
            );
          }
          const viewEnd = Math.min(viewStart + MAX_VISIBLE, allEntries.length);

          // Determine which group headers fall within the visible range
          const activeEnd = groups.active.length;

          return (
            <Box marginTop={1} flexDirection="column">
              {viewStart > 0 && <Text dimColor> ↑ {viewStart} more</Text>}
              {viewStart < activeEnd && (
                <Box flexDirection="column">
                  {viewStart === 0 && groups.active.length > 0 && (
                    <Text bold dimColor>
                      Active Stashes:
                    </Text>
                  )}
                  {groups.active
                    .map((entry, i) => ({ entry, globalIdx: i }))
                    .filter(({ globalIdx }) => globalIdx >= viewStart && globalIdx < viewEnd)
                    .map(({ entry, globalIdx }) => renderStashEntry(entry, globalIdx))}
                </Box>
              )}
              {viewEnd > activeEnd && groups.archived.length > 0 && (
                <Box flexDirection="column" marginTop={viewStart < activeEnd ? 1 : 0}>
                  {activeEnd >= viewStart && (
                    <Text bold dimColor>
                      Archived Stashes:
                    </Text>
                  )}
                  {groups.archived
                    .map((entry, i) => ({ entry, globalIdx: activeEnd + i }))
                    .filter(({ globalIdx }) => globalIdx >= viewStart && globalIdx < viewEnd)
                    .map(({ entry, globalIdx }) => renderStashEntry(entry, globalIdx))}
                </Box>
              )}
              {viewEnd < allEntries.length && (
                <Text dimColor> ↓ {allEntries.length - viewEnd} more</Text>
              )}
            </Box>
          );
        })()
      )}

      <Box marginTop={1}>
        {isBulk ? (
          <Text dimColor>Space: toggle Enter: delete selected Esc: cancel q: quit</Text>
        ) : (
          <Text dimColor>a: apply d: diff x: delete X: bulk delete Esc: back q: quit</Text>
        )}
      </Box>
    </Box>
  );
}
