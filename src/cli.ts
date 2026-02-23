#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runInit } from "./commands/init.js";
import { runShellInit, type ShellType } from "./commands/shell-init.js";
import { runCheckout } from "./commands/checkout.js";
import { runSync } from "./commands/sync.js";
import { runFetch } from "./commands/fetch.js";
import {
  runStashList,
  runStashApply,
  runStashDrop,
  runStashShow,
} from "./commands/stash.js";
import { runList } from "./commands/list.js";
import { runPin, runUnpin } from "./commands/pin.js";
import { runClean } from "./commands/clean.js";

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
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
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
      process.stdout.write(runShellInit(argv.shell as ShellType) + "\n");
    }
  )
  .command(
    ["checkout <branch>", "co <branch>"],
    "Check out a branch (evicts LRU slot if needed)",
    (yargs) =>
      yargs
        .positional("branch", { type: "string", demandOption: true })
        .option("no-restore", {
          type: "boolean",
          default: false,
          describe: "Skip automatic stash restoration",
        }),
    async (argv) => {
      try {
        await runCheckout({
          branch: argv.branch as string,
          noRestore: argv["no-restore"],
        });
      } catch (err: unknown) {
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
  )
  .command(
    "fetch",
    "Run a centralized git fetch and archive scan",
    () => {},
    async () => {
      try {
        await runFetch();
      } catch (err: unknown) {
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
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
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
  )
  .command(
    "sync",
    "Sync shared symlinks and regenerate templates",
    () => {},
    async () => {
      try {
        await runSync();
      } catch (err: unknown) {
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
  )
  .command(
    "clean",
    "Review and delete archived stashes",
    () => {},
    async () => {
      try {
        await runClean();
      } catch (err: unknown) {
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
  )
  .command(
    ["list", "ls"],
    "List all worktree slots with status",
    () => {},
    async () => {
      try {
        await runList();
      } catch (err: unknown) {
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
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
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
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
        process.stderr.write(`wt: ${(err as Error).message}\n`);
        process.exit(1);
      }
    }
  )
  .demandCommand(1, "Run 'wt --help' for usage information")
  .strict()
  .help()
  .version("0.1.0");

await cli.parseAsync();
