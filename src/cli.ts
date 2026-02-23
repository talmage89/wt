#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runInit } from "./commands/init.js";
import { runShellInit, type ShellType } from "./commands/shell-init.js";
import { runCheckout } from "./commands/checkout.js";

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
  .command("fetch", "Run centralized git fetch and archive scan", () => {}, () => {
    process.stderr.write("wt: fetch not yet implemented\n");
    process.exit(1);
  })
  .command(
    "stash <action>",
    "Manage stashes (list|apply|drop|show)",
    () => {},
    () => {
      process.stderr.write("wt: stash not yet implemented\n");
      process.exit(1);
    }
  )
  .command("sync", "Sync shared symlinks and regenerate templates", () => {}, () => {
    process.stderr.write("wt: sync not yet implemented\n");
    process.exit(1);
  })
  .command("clean", "Review and delete archived stashes", () => {}, () => {
    process.stderr.write("wt: clean not yet implemented\n");
    process.exit(1);
  })
  .command(
    ["list", "ls"],
    "List all worktree slots with status",
    () => {},
    () => {
      process.stderr.write("wt: list not yet implemented\n");
      process.exit(1);
    }
  )
  .command(
    "pin [slot]",
    "Pin a worktree slot to prevent LRU eviction",
    () => {},
    () => {
      process.stderr.write("wt: pin not yet implemented\n");
      process.exit(1);
    }
  )
  .command(
    "unpin [slot]",
    "Unpin a worktree slot",
    () => {},
    () => {
      process.stderr.write("wt: unpin not yet implemented\n");
      process.exit(1);
    }
  )
  .demandCommand(1, "Run 'wt --help' for usage information")
  .strict()
  .help()
  .version("0.1.0");

await cli.parseAsync();
