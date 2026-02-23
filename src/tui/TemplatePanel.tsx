import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ContainerPaths } from "../core/container.js";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

// TODO: Implement full TemplatePanel per PHASE-7.md Section 7.7
// List template source files, allow editing and regeneration
export function TemplatePanel({ onBack }: Props) {
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
      <Text bold>Edit Templates</Text>
      <Box marginTop={1}>
        <Text dimColor>
          TemplatePanel not yet implemented. Press Esc to go back, q to quit.
        </Text>
      </Box>
    </Box>
  );
}
