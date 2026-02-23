import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import SelectInput from "ink-select-input";

type Screen = "worktrees" | "stashes" | "config" | "templates";

interface MenuItem {
  label: string;
  value: Screen;
}

const items: MenuItem[] = [
  { label: "Manage Worktrees", value: "worktrees" },
  { label: "Manage Stashes", value: "stashes" },
  { label: "Edit Configuration", value: "config" },
  { label: "Edit Templates", value: "templates" },
];

interface Props {
  onSelect: (screen: Screen) => void;
}

export function MainMenu({ onSelect }: Props) {
  const { exit } = useApp();

  useInput((input) => {
    if (input === "q") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>wt — Git Worktree Control Plane</Text>
      <Box marginTop={1}>
        <SelectInput<Screen>
          items={items}
          onSelect={(item) => onSelect(item.value)}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate  Enter select  q quit</Text>
      </Box>
    </Box>
  );
}
