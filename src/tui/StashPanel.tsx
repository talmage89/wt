import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ContainerPaths } from "../core/container.js";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

// TODO: Implement full StashPanel per PHASE-7.md Section 7.5
// Grouped stash display (active/archived) with apply, diff, delete, bulk-delete actions
export function StashPanel({ onBack }: Props) {
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape || input === "q") {
      if (key.escape) {
        onBack();
      } else {
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Manage Stashes</Text>
      <Box marginTop={1}>
        <Text dimColor>
          StashPanel not yet implemented. Press Esc to go back, q to quit.
        </Text>
      </Box>
    </Box>
  );
}
