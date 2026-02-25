import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { spawn, execFile } from "child_process";
import { readdir, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import type { ContainerPaths } from "../core/container.js";

const POST_CHECKOUT_TEMPLATE = `#!/usr/bin/env bash
# wt post-checkout hook
# Arguments:
#   $1 — worktree directory (absolute path)
#   $2 — branch name
#
# This hook runs after 'wt checkout' places a branch into a slot.
# Example: announce the checkout
# echo "wt: checked out $2 in $1"
`;

interface HookFile {
  name: string;
  path: string;
  executable: boolean;
}

type Mode = "list" | "editing" | "chmod_prompt" | "creating";

interface Props {
  paths: ContainerPaths;
  onBack: () => void;
}

async function checkExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function HooksPanel({ paths, onBack }: Props) {
  const { exit } = useApp();
  const hooksDir = join(paths.wtDir, "hooks");

  const [mode, setMode] = useState<Mode>("list");
  const [hooks, setHooks] = useState<HookFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pendingHook, setPendingHook] = useState<HookFile | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadHooks = (): Promise<void> => {
    return readdir(hooksDir)
      .then((entries) => {
        const files = entries.filter((e) => !e.startsWith(".")).sort();
        return Promise.all(
          files.map(async (name): Promise<HookFile> => {
            const p = join(hooksDir, name);
            const executable = await checkExecutable(p);
            return { name, path: p, executable };
          })
        );
      })
      .then((hookFiles) => {
        setHooks(hookFiles);
        setLoading(false);
      })
      .catch(() => {
        setHooks([]);
        setLoading(false);
      });
  };

  useEffect(() => {
    void loadHooks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openEditor = (hook: HookFile): void => {
    const editor = process.env["EDITOR"] ?? "vi";
    setMode("editing");
    const child = spawn(editor, [hook.path], { stdio: "inherit" });
    child.on("exit", () => {
      void checkExecutable(hook.path).then((executable) => {
        const updated: HookFile = { ...hook, executable };
        void loadHooks().then(() => {
          if (!executable) {
            setPendingHook(updated);
            setMode("chmod_prompt");
          } else {
            setStatusMsg(`${hook.name} saved.`);
            setMode("list");
          }
        });
      });
    });
    child.on("error", (err) => {
      process.stderr.write(`wt: failed to launch editor: ${err.message}\n`);
      setMode("list");
    });
  };

  const createAndEdit = (name: string, content: string): void => {
    const hookPath = join(hooksDir, name);
    setMode("creating");
    void writeFile(hookPath, content, { mode: 0o644 })
      .then(() => loadHooks())
      .then(() => {
        openEditor({ name, path: hookPath, executable: false });
      })
      .catch((err: unknown) => {
        setError(String(err));
        setMode("list");
      });
  };

  const doChmod = (): void => {
    if (!pendingHook) return;
    execFile("chmod", ["+x", pendingHook.path], (err) => {
      if (err) {
        setError(`chmod failed: ${err.message}`);
        setMode("list");
        return;
      }
      const name = pendingHook.name;
      setPendingHook(null);
      setStatusMsg(`${name} is now executable.`);
      void loadHooks().then(() => setMode("list"));
    });
  };

  const hasPostCheckout = hooks.some((h) => h.name === "post-checkout");
  // Total selectable items: existing hooks + optional create row
  const listLen = hooks.length + (hasPostCheckout ? 0 : 1);

  useInput((input, key) => {
    if (mode === "editing" || mode === "creating") return;

    if (error !== null) {
      setError(null);
      return;
    }

    if (mode === "chmod_prompt") {
      if (input === "y" || input === "Y") {
        doChmod();
      } else {
        setPendingHook(null);
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
      setSelectedIdx((i) => Math.min(listLen - 1, i + 1));
    } else if (key.return) {
      if (selectedIdx < hooks.length) {
        const hook = hooks[selectedIdx];
        if (hook) openEditor(hook);
      } else if (!hasPostCheckout) {
        createAndEdit("post-checkout", POST_CHECKOUT_TEMPLATE);
      }
    } else if (statusMsg !== null) {
      setStatusMsg(null);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Hooks</Text>
        <Box marginTop={1}>
          <Text dimColor>Loading...</Text>
        </Box>
      </Box>
    );
  }

  if (error !== null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Hooks</Text>
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press any key to continue</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "chmod_prompt") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit Hooks</Text>
        <Box marginTop={1}>
          <Text>
            <Text bold color="yellow">
              {pendingHook?.name}
            </Text>{" "}
            is not executable. Run <Text bold>chmod +x</Text>? [y/N]
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>y: yes  any other key: skip</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Edit Hooks</Text>
      <Box marginTop={1} flexDirection="column">
        {hooks.map((hook, i) => {
          const isSelected = i === selectedIdx;
          return (
            <Box key={hook.name}>
              <Text color={isSelected ? "cyan" : undefined}>
                {isSelected ? "› " : "  "}
              </Text>
              <Text bold={isSelected} color={isSelected ? "cyan" : undefined}>
                {hook.name}
              </Text>
              <Text dimColor>
                {"  "}
                {hook.executable ? "[executable]" : "[not executable]"}
              </Text>
            </Box>
          );
        })}
        {!hasPostCheckout && (() => {
          const isSelected = selectedIdx === hooks.length;
          return (
            <Box>
              <Text color={isSelected ? "cyan" : undefined}>
                {isSelected ? "› " : "  "}
              </Text>
              <Text
                dimColor={!isSelected}
                color={isSelected ? "cyan" : undefined}
              >
                + Create post-checkout hook
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
        <Text dimColor>Enter: edit  Esc: back  q: quit</Text>
      </Box>
    </Box>
  );
}
