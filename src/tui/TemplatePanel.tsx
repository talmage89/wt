import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdin } from "ink";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { writeFile, mkdir } from "fs/promises";
import type { ContainerPaths } from "../core/container.js";
import type { TemplateConfig } from "../core/config.js";
import { readConfig, writeConfig } from "../core/config.js";
import { readState } from "../core/state.js";
import { generateAllTemplates } from "../core/templates.js";
import { handleTextEditingKeys } from "./input-helpers.js";

type Mode =
  | "list"
  | "confirm_regen"
  | "regenerating"
  | "editing"
  | "new_source"
  | "new_target"
  | "confirm_delete";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

export function TemplatePanel({ paths, onBack }: Props) {
  const { exit } = useApp();
  const { setRawMode } = useStdin();

  const [mode, setMode] = useState<Mode>("list");
  const [templates, setTemplates] = useState<TemplateConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [editedTemplate, setEditedTemplate] = useState<TemplateConfig | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // New template creation state
  const [newSource, setNewSource] = useState("");
  const [newTarget, setNewTarget] = useState("");

  // Delete target
  const [deleteTarget, setDeleteTarget] = useState<TemplateConfig | null>(null);

  // Total selectable items: existing templates + create row
  const listLen = templates.length + 1;

  const reloadTemplates = () => {
    readConfig(paths.wtDir)
      .then((config) => {
        setTemplates(config.templates);
      })
      .catch((err: unknown) => {
        setError(String(err));
      });
  };

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
    // Release stdin and clear screen so the editor gets a clean terminal
    setRawMode(false);
    process.stdout.write("\x1b[2J\x1b[H");
    const child = spawn(editor, [sourcePath], {
      stdio: "inherit",
      cwd: dirname(sourcePath),
    });
    child.on("exit", () => {
      setRawMode(true);
      setEditedTemplate(tmpl);
      setMode("confirm_regen");
    });
    child.on("error", (err) => {
      setRawMode(true);
      process.stderr.write(`wt: failed to launch editor: ${err.message}\n`);
      setMode("list");
    });
  };

  const doCreateTemplate = async (source: string, target: string) => {
    try {
      // Add to config
      const config = await readConfig(paths.wtDir);
      config.templates.push({ source, target });
      await writeConfig(paths.wtDir, config);

      // Create the source file (with parent dirs)
      const sourcePath = join(paths.wtDir, source);
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, "", { flag: "wx" }).catch(() => {
        // File already exists — that's fine
      });

      // Reload template list, then open in editor
      reloadTemplates();
      doEditTemplate({ source, target });
    } catch (err: unknown) {
      setError(String(err));
      setMode("list");
    }
  };

  const doDeleteTemplate = async (tmpl: TemplateConfig) => {
    try {
      const config = await readConfig(paths.wtDir);
      config.templates = config.templates.filter(
        (t) => t.source !== tmpl.source || t.target !== tmpl.target
      );
      await writeConfig(paths.wtDir, config);
      setDeleteTarget(null);
      setStatusMsg(`Removed template ${tmpl.source} → ${tmpl.target}.`);
      reloadTemplates();
      setSelectedIdx((i) => Math.max(0, i - 1));
      setMode("list");
    } catch (err: unknown) {
      setError(String(err));
      setDeleteTarget(null);
      setMode("list");
    }
  };

  useInput((input, key) => {
    if (mode === "editing" || mode === "regenerating") return;

    if (error !== null) {
      if (input === "q") exit();
      else setError(null);
      return;
    }

    // New template: source input
    if (mode === "new_source") {
      if (key.escape) {
        setMode("list");
        setNewSource("");
      } else if (key.return) {
        const source = newSource.trim();
        if (source) {
          setMode("new_target");
          setNewTarget("");
        }
      } else if (handleTextEditingKeys(input, key, setNewSource)) {
        // Option+Backspace, Ctrl+W, Ctrl+U handled
      } else if (key.backspace || key.delete) {
        setNewSource((s) => s.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input.length === 1) {
        setNewSource((s) => s + input);
      }
      return;
    }

    // New template: target input
    if (mode === "new_target") {
      if (key.escape) {
        setMode("new_source");
      } else if (key.return) {
        const target = newTarget.trim();
        if (target) {
          const source = newSource.trim();
          setNewSource("");
          setNewTarget("");
          void doCreateTemplate(source, target);
        }
      } else if (handleTextEditingKeys(input, key, setNewTarget)) {
        // Option+Backspace, Ctrl+W, Ctrl+U handled
      } else if (key.backspace || key.delete) {
        setNewTarget((t) => t.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && input.length === 1) {
        setNewTarget((t) => t + input);
      }
      return;
    }

    // Confirm delete
    if (mode === "confirm_delete") {
      if (input === "y" || input === "Y") {
        if (deleteTarget) void doDeleteTemplate(deleteTarget);
      } else {
        setDeleteTarget(null);
        setMode("list");
      }
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
    } else if (key.upArrow || input === "k" || (key.ctrl && input === "p")) {
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j" || (key.ctrl && input === "n")) {
      setSelectedIdx((i) => Math.min(listLen - 1, i + 1));
    } else if (key.return) {
      if (selectedIdx < templates.length) {
        const tmpl = templates[selectedIdx];
        if (tmpl) doEditTemplate(tmpl);
      } else {
        // "Create template" row
        setMode("new_source");
        setNewSource("templates/");
        setNewTarget("");
      }
    } else if (input === "x") {
      const tmpl = templates[selectedIdx];
      if (tmpl) {
        setDeleteTarget(tmpl);
        setMode("confirm_delete");
      }
    } else if (input === "r" && !key.ctrl) {
      if (templates.length > 0) doRegenAll();
    } else if (statusMsg !== null) {
      setStatusMsg(null);
    }
  });

  // --- Render ---

  if (mode === "editing") {
    return <Box />;
  }

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

  if (mode === "confirm_delete") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Templates</Text>
        <Box marginTop={1}>
          <Text>
            Remove template{" "}
            <Text bold color="yellow">
              {deleteTarget?.source} → {deleteTarget?.target}
            </Text>
            ? [y/N]
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>y: yes  any other key: cancel</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "new_source") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>New Template</Text>
        <Box marginTop={1}>
          <Text bold color="green">source (relative to .wt/): </Text>
          <Text>{newSource}</Text>
          <Text color="cyan">█</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter: next  Esc: cancel</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "new_target") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>New Template</Text>
        <Box marginTop={1}>
          <Text dimColor>source: {newSource}</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold color="green">target (relative to worktree): </Text>
          <Text>{newTarget}</Text>
          <Text color="cyan">█</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter: create  Esc: back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Edit Templates</Text>
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
        {(() => {
          const isSelected = selectedIdx === templates.length;
          return (
            <Box>
              <Text color={isSelected ? "cyan" : undefined}>
                {isSelected ? "› " : "  "}
              </Text>
              <Text
                dimColor={!isSelected}
                color={isSelected ? "cyan" : undefined}
              >
                + Create template
              </Text>
            </Box>
          );
        })()}
      </Box>
      {statusMsg && (
        <Box marginTop={1}>
          <Text color="green">{statusMsg}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter: edit  x: delete  r: regenerate all  Esc: back  q: quit</Text>
      </Box>
    </Box>
  );
}
