import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { spawn } from "child_process";
import { join } from "path";
import type { ContainerPaths } from "../core/container.js";
import { readConfig, type Config } from "../core/config.js";
import { readState } from "../core/state.js";
import { adjustSlotCount } from "../core/slots.js";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

function diffConfig(before: Config, after: Config): string[] {
  const changes: string[] = [];

  if (before.slot_count !== after.slot_count) {
    changes.push(
      `slot_count: ${before.slot_count} → ${after.slot_count}` +
        `  (new slots will be created/evicted on next wt command)`
    );
  }

  if (before.archive_after_days !== after.archive_after_days) {
    changes.push(
      `archive_after_days: ${before.archive_after_days} → ${after.archive_after_days}`
    );
  }

  const beforeDirs = JSON.stringify(before.shared.directories.slice().sort());
  const afterDirs = JSON.stringify(after.shared.directories.slice().sort());
  if (beforeDirs !== afterDirs) {
    changes.push(`shared.directories changed  (run 'wt sync' to apply)`);
  }

  const beforeTemplates = JSON.stringify(before.templates);
  const afterTemplates = JSON.stringify(after.templates);
  if (beforeTemplates !== afterTemplates) {
    changes.push(`templates changed  (run 'wt sync' to apply)`);
  }

  return changes;
}

type Phase = "editing" | "slot-prompt" | "applying" | "summary";

// Launches $EDITOR on .wt/config.toml per PHASE-7.md Section 7.6
export function ConfigPanel({ paths, onBack }: Props) {
  const { exit: _exit } = useApp();
  const { setRawMode } = useStdin();
  const [phase, setPhase] = useState<Phase>("editing");
  const [changes, setChanges] = useState<string[]>([]);
  const [slotCountChange, setSlotCountChange] = useState<{
    before: number;
    after: number;
  } | null>(null);
  const [afterConfig, setAfterConfig] = useState<Config | null>(null);
  const [triggerApply, setTriggerApply] = useState(false);

  useEffect(() => {
    const editor = process.env["EDITOR"] ?? "vi";
    const configPath = join(paths.wtDir, "config.toml");

    const openEditor = (before: Config | null) => {
      // Disable Ink's raw mode so the external editor has exclusive stdin control.
      // Without this, Ink intercepts keystrokes meant for the editor, causing
      // double-registration of each key press.
      setRawMode(false);
      process.stdout.write("\x1b[2J\x1b[H");
      const child = spawn(editor, [configPath], { stdio: "inherit" });
      child.on("exit", () => {
        setRawMode(true);
        if (before === null) {
          setChanges([]);
          setPhase("summary");
          return;
        }
        readConfig(paths.wtDir)
          .then((after) => {
            const allChanges = diffConfig(before, after);

            if (before.slot_count !== after.slot_count) {
              // Filter out the slot_count line — handled via the apply prompt
              const otherChanges = allChanges.filter(
                (l) => !l.startsWith("slot_count:")
              );
              setChanges(otherChanges);
              setSlotCountChange({
                before: before.slot_count,
                after: after.slot_count,
              });
              setAfterConfig(after);
              setPhase("slot-prompt");
            } else {
              setChanges(allChanges);
              setPhase("summary");
            }
          })
          .catch(() => {
            setChanges([]);
            setPhase("summary");
          });
      });
      child.on("error", (err) => {
        setRawMode(true);
        process.stderr.write(`wt: failed to launch editor: ${err.message}\n`);
        onBack();
      });
    };

    readConfig(paths.wtDir)
      .then((before) => openEditor(before))
      .catch(() => openEditor(null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply slot count change asynchronously when triggered
  useEffect(() => {
    if (!triggerApply || !afterConfig || !slotCountChange) return;

    (async () => {
      try {
        const state = await readState(paths.wtDir);
        const oldSlotNames = new Set(Object.keys(state.slots));
        const newState = await adjustSlotCount(
          paths.repoDir,
          paths.container,
          paths.wtDir,
          state,
          afterConfig
        );
        const newSlotNames = new Set(Object.keys(newState.slots));

        const created = [...newSlotNames].filter((n) => !oldSlotNames.has(n));
        const evicted = [...oldSlotNames].filter((n) => !newSlotNames.has(n));

        const resultLines: string[] = [
          `slot_count: ${slotCountChange.before} → ${slotCountChange.after}`,
        ];
        if (created.length > 0) {
          resultLines.push(
            `  Created ${created.length} new slot${created.length !== 1 ? "s" : ""}: ${created.join(", ")}`
          );
        }
        if (evicted.length > 0) {
          resultLines.push(
            `  Evicted ${evicted.length} slot${evicted.length !== 1 ? "s" : ""}: ${evicted.join(", ")}`
          );
        }

        setChanges((prev) => [...prev, ...resultLines]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setChanges((prev) => [
          ...prev,
          `slot_count: ${slotCountChange.before} → ${slotCountChange.after}  (error: ${msg})`,
        ]);
      }

      setTriggerApply(false);
      setPhase("summary");
    })();
  }, [triggerApply]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input) => {
    if (phase === "summary") {
      onBack();
    } else if (phase === "slot-prompt") {
      if (input === "y" || input === "Y") {
        setPhase("applying");
        setTriggerApply(true);
      } else {
        // n or any other key → decline, show deferred guidance
        setChanges((prev) => [
          ...prev,
          `slot_count: ${slotCountChange!.before} → ${slotCountChange!.after}  (new slots will be created/evicted on next wt command)`,
        ]);
        setPhase("summary");
      }
    }
  });

  if (phase === "editing") {
    return <Box />;
  }

  if (phase === "slot-prompt") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Config changes</Text>
        <Box marginTop={1} flexDirection="column">
          {changes.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          <Box marginTop={changes.length > 0 ? 1 : 0}>
            <Text>
              slot_count: {slotCountChange!.before} → {slotCountChange!.after}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text>Apply slot count change now? (y/n)</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (phase === "applying") {
    return (
      <Box padding={1}>
        <Text>Applying slot count change...</Text>
      </Box>
    );
  }

  // Summary phase
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Config changes</Text>
      <Box marginTop={1} flexDirection="column">
        {changes.length === 0 ? (
          <Text dimColor>No changes.</Text>
        ) : (
          changes.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press any key to continue</Text>
      </Box>
    </Box>
  );
}
