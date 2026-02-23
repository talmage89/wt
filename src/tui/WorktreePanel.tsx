import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ContainerPaths } from "../core/container.js";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

// TODO: Implement full WorktreePanel per PHASE-7.md Section 7.4
// Branch-centric view with pinned/active/inactive tiers, search, checkout, pin/unpin
export function WorktreePanel({ onBack }: Props) {
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
      <Text bold>Manage Worktrees</Text>
      <Box marginTop={1}>
        <Text dimColor>
          WorktreePanel not yet implemented. Press Esc to go back, q to quit.
        </Text>
      </Box>
    </Box>
  );
}
