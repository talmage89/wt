import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { spawn } from "child_process";
import { join } from "path";
import type { ContainerPaths } from "../core/container.js";
import type { TemplateConfig } from "../core/config.js";
import { readConfig } from "../core/config.js";
import { readState } from "../core/state.js";
import { generateAllTemplates } from "../core/templates.js";

type Mode = "list" | "confirm_regen" | "regenerating" | "editing";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

export function TemplatePanel({ paths, onBack }: Props) {
  const { exit } = useApp();

  const [mode, setMode] = useState<Mode>("list");
  const [templates, setTemplates] = useState<TemplateConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [editedTemplate, setEditedTemplate] = useState<TemplateConfig | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    readConfig(paths.wtDir)
      .then((config) => {
        setTemplates(config.templates);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(String(err));
        setLoading(false);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doRegenAll = () => {
    setMode("regenerating");
    setStatusMsg(null);
    Promise.all([readConfig(paths.wtDir), readState(paths.wtDir)])
      .then(([config, state]) =>
        generateAllTemplates(
          paths.wtDir,
          paths.container,
          state.slots,
          config.templates
        )
      )
      .then(() => {
        setStatusMsg("Templates regenerated across all worktrees.");
        setMode("list");
        setEditedTemplate(null);
      })
      .catch((err: unknown) => {
        setError(String(err));
        setMode("list");
        setEditedTemplate(null);
      });
  };

  const doEditTemplate = (tmpl: TemplateConfig) => {
    const editor = process.env["EDITOR"] ?? "vi";
    const sourcePath = join(paths.wtDir, tmpl.source);

    setMode("editing");
    const child = spawn(editor, [sourcePath], { stdio: "inherit" });
    child.on("exit", () => {
      setEditedTemplate(tmpl);
      setMode("confirm_regen");
    });
    child.on("error", (err) => {
      process.stderr.write(`wt: failed to launch editor: ${err.message}\n`);
      setMode("list");
    });
  };

  useInput((input, key) => {
    if (mode === "editing" || mode === "regenerating") return;

    if (error !== null) {
      if (input === "q") exit();
      else setError(null);
      return;
    }

    if (mode === "confirm_regen") {
      if (input === "y" || input === "Y") {
        doRegenAll();
      } else {
        setEditedTemplate(null);
        setMode("list");
      }
      return;
    }

    // List mode
    if (key.escape) {
      onBack();
    } else if (input === "q") {
      exit();
    } else if (key.upArrow || input === "k") {
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIdx((i) =>
        templates.length === 0 ? 0 : Math.min(templates.length - 1, i + 1)
      );
    } else if (key.return) {
      const tmpl = templates[selectedIdx];
      if (tmpl) doEditTemplate(tmpl);
    } else if (input === "r") {
      if (templates.length > 0) doRegenAll();
    } else if (statusMsg !== null) {
      setStatusMsg(null);
    }
  });

  // --- Render ---

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Templates</Text>
        <Box marginTop={1}>
          <Text dimColor>Loading...</Text>
        </Box>
      </Box>
    );
  }

  if (error !== null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Templates</Text>
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press any key to continue, q to quit</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "regenerating") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Templates</Text>
        <Box marginTop={1}>
          <Text>Regenerating templates...</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "confirm_regen") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Templates</Text>
        <Box marginTop={1}>
          <Text>
            Regenerate{" "}
            <Text bold color="yellow">
              {editedTemplate?.source}
            </Text>{" "}
            across all worktrees? [y/N]
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>y: yes  any other key: no</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Edit Templates</Text>
      {templates.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            No templates configured. Edit .wt/config.toml to add templates.
          </Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {templates.map((tmpl, i) => {
            const isSelected = i === selectedIdx;
            return (
              <Box key={`${tmpl.source}→${tmpl.target}`}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "› " : "  "}
                </Text>
                <Text bold={isSelected} color={isSelected ? "cyan" : undefined}>
                  {tmpl.source}
                </Text>
                <Text dimColor>  →  {tmpl.target}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      {statusMsg && (
        <Box marginTop={1}>
          <Text color="green">{statusMsg}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter: edit  r: regenerate all  Esc: back  q: quit</Text>
      </Box>
    </Box>
  );
}
