#!/usr/bin/env node
// Restore cursor visibility on exit — Ink (and some CLI tools) hide the cursor
// and may not restore it if the process is killed or crashes.
process.on("exit", () => {
  if (process.stdout.isTTY) process.stdout.write("\x1B[?25h");
});

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runCheckout } from "./commands/checkout.js";
import { runClean } from "./commands/clean.js";
import { runFetch } from "./commands/fetch.js";
import { runHooksShow } from "./commands/hooks.js";
import { runInit } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { runPin, runUnpin } from "./commands/pin.js";
import { runResume } from "./commands/resume.js";
import { runShellInit, type ShellType } from "./commands/shell-init.js";
import { runStashApply, runStashDrop, runStashList, runStashShow } from "./commands/stash.js";
import { runSync } from "./commands/sync.js";
import { findContainer } from "./core/container.js";

// `wt -` is a shorthand for `wt resume`. Handle before yargs parses it,
// since `.strict()` would reject `-` as an unknown command.
if (process.argv[2] === "-") {
  try {
    await runResume();
  } catch (err: unknown) {
    process.stderr.write(`wt: ${(err as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// When invoked with no arguments, launch the TUI (if inside a container)
// or show help (if outside).
if (process.argv.length <= 2) {
  const paths = await findContainer(process.cwd());
  if (paths) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "wt: TUI requires an interactive terminal. Use 'wt <command>' for CLI usage.\n",
      );
      process.exit(1);
    }
    const { render } = await import("ink");
    const React = await import("react");
    const { App } = await import("./tui/App.js");
    const { waitUntilExit } = render(React.createElement(App, { containerPaths: paths }));
    await waitUntilExit();
    process.exit(0);
  } else {
    // Print help below after building the cli object
  }
}

/**
 * Handle errors from CLI command handlers.
 * ExecaErrors (git failures): stderr has already been printed via stdio inherit.
 * Just exit with the same exit code — no extra message.
 * Other errors: print `wt: <message>` and exit 1.
 */
function handleCliError(err: unknown): never {
  if (typeof (err as { exitCode?: unknown }).exitCode === "number") {
    process.exit((err as { exitCode: number }).exitCode);
  }
  process.stderr.write(`wt: ${(err as Error).message}\n`);
  process.exit(1);
}

const cli = yargs(hideBin(process.argv))
  .scriptName("wt")
  .usage("$0 <command> [options]")
  .command(
    "init [url]",
    "Initialize a wt-managed container",
    (yargs) =>
      yargs.positional("url", {
        type: "string",
        describe: "Repository URL to clone (optional — omit to restructure cwd)",
      }),
    async (argv) => {
      try {
        await runInit({ url: argv.url });
        // nav file written by runInit; shell function handles the cd
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "shell-init <shell>",
    "Output shell integration code",
    (yargs) =>
      yargs.positional("shell", {
        type: "string",
        choices: ["bash", "zsh", "fish"],
        demandOption: true,
        describe: "Shell type (bash, zsh, or fish)",
      }),
    (argv) => {
      process.stdout.write(`${runShellInit(argv.shell as ShellType)}\n`);
    },
  )
  .command(
    ["checkout <branch> [start-point]", "co <branch> [start-point]"],
    "Check out a branch (evicts LRU slot if needed)",
    (yargs) =>
      yargs
        .positional("branch", { type: "string", demandOption: true })
        .positional("start-point", {
          type: "string",
          describe: "Start point for branch creation (only used with -b)",
        })
        .option("b", {
          type: "boolean",
          describe: "Create a new branch at start-point (default: origin/<default-branch>)",
        })
        .option("restore", {
          type: "boolean",
          default: true,
          describe: "Automatically restore stash on checkout (use --no-restore to skip)",
        }),
    async (argv) => {
      try {
        await runCheckout({
          branch: argv.branch as string,
          noRestore: !argv.restore,
          create: argv.b ?? false,
          startPoint: argv["start-point"] as string | undefined,
        });
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "fetch",
    "Run a centralized git fetch and archive scan",
    () => {},
    async () => {
      try {
        await runFetch();
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "stash <action> [branch]",
    "Manage stashes (list|apply|drop|show)",
    (yargs) =>
      yargs
        .positional("action", {
          type: "string",
          choices: ["list", "apply", "drop", "show"] as const,
          demandOption: true,
          describe: "Stash subcommand",
        })
        .positional("branch", {
          type: "string",
          describe: "Branch name (defaults to current branch)",
        }),
    async (argv) => {
      try {
        switch (argv.action) {
          case "list":
            await runStashList();
            break;
          case "apply":
            await runStashApply(argv.branch as string | undefined);
            break;
          case "drop":
            await runStashDrop(argv.branch as string | undefined);
            break;
          case "show":
            await runStashShow(argv.branch as string | undefined);
            break;
        }
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "sync",
    "Sync shared symlinks and regenerate templates",
    () => {},
    async () => {
      try {
        await runSync();
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "clean",
    "Review and delete archived stashes",
    () => {},
    async () => {
      try {
        await runClean();
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    ["list", "ls"],
    "List all worktree slots with status",
    () => {},
    async () => {
      try {
        await runList();
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "pin [slot]",
    "Pin a worktree slot to prevent LRU eviction",
    (yargs) =>
      yargs.positional("slot", {
        type: "string",
        describe: "Slot name (defaults to current worktree)",
      }),
    async (argv) => {
      try {
        await runPin(argv.slot as string | undefined);
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "unpin [slot]",
    "Unpin a worktree slot",
    (yargs) =>
      yargs.positional("slot", {
        type: "string",
        describe: "Slot name (defaults to current worktree)",
      }),
    async (argv) => {
      try {
        await runUnpin(argv.slot as string | undefined);
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "resume",
    "Navigate to the most recently used worktree (like cd -)",
    () => {},
    async () => {
      try {
        await runResume();
      } catch (err: unknown) {
        handleCliError(err);
      }
    },
  )
  .command(
    "hooks <action> [integration]",
    "Show integration hook configurations",
    (yargs) =>
      yargs
        .positional("action", {
          type: "string",
          choices: ["show"] as const,
          demandOption: true,
          describe: "Hooks subcommand",
        })
        .positional("integration", {
          type: "string",
          describe: "Integration name (e.g., claude-code)",
        }),
    (argv) => {
      if (argv.action === "show") {
        if (!argv.integration) {
          process.stderr.write(
            "wt: 'hooks show' requires an integration name (e.g., claude-code)\n",
          );
          process.exit(1);
        }
        runHooksShow(argv.integration as string);
      }
    },
  )
  .demandCommand(1, "Run 'wt --help' for usage information")
  .strict()
  .help()
  .version("0.1.0");

if (process.argv.length <= 2) {
  cli.showHelp();
  process.exit(0);
}

await cli.parseAsync();
