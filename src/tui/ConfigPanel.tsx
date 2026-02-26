import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { spawn } from "child_process";
import { join } from "path";
import type { ContainerPaths } from "../core/container.js";
import { readConfig, type Config } from "../core/config.js";

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

type Phase = "editing" | "summary";

// Launches $EDITOR on .wt/config.toml per PHASE-7.md Section 7.6
export function ConfigPanel({ paths, onBack }: Props) {
  const { exit: _exit } = useApp();
  const { setRawMode } = useStdin();
  const [phase, setPhase] = useState<Phase>("editing");
  const [changes, setChanges] = useState<string[]>([]);

  useEffect(() => {
    const editor = process.env["EDITOR"] ?? "vi";
    const configPath = join(paths.wtDir, "config.toml");

    const openEditor = (before: Config | null) => {
      // Disable Ink's raw mode so the external editor has exclusive stdin control.
      // Without this, Ink intercepts keystrokes meant for the editor, causing
      // double-registration of each key press.
      setRawMode(false);
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
            setChanges(diffConfig(before, after));
            setPhase("summary");
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

  useInput(() => {
    if (phase === "summary") {
      onBack();
    }
  });

  if (phase === "editing") {
    return (
      <Box padding={1}>
        <Text>Opening editor...</Text>
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
