import React, { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { spawn } from "child_process";
import { join } from "path";
import type { ContainerPaths } from "../core/container.js";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

// Launches $EDITOR on .wt/config.toml per PHASE-7.md Section 7.6
export function ConfigPanel({ paths, onBack }: Props) {
  const { exit } = useApp();

  useEffect(() => {
    const editor = process.env["EDITOR"] ?? "vi";
    const configPath = join(paths.wtDir, "config.toml");

    const child = spawn(editor, [configPath], { stdio: "inherit" });
    child.on("exit", () => {
      onBack();
    });
    child.on("error", (err) => {
      process.stderr.write(`wt: failed to launch editor: ${err.message}\n`);
      onBack();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box padding={1}>
      <Text>Opening editor...</Text>
    </Box>
  );
}
