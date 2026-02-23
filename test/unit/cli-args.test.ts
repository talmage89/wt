import { describe, it, expect } from "vitest";
import yargs from "yargs";

// BUG-004: `wt checkout --no-restore <branch>` failed with "Unknown argument: restore"
// under yargs strict mode. When an option is named "no-restore", yargs' boolean-negation
// strips the "no-" prefix and looks for a base option named "restore". Since only
// "no-restore" was defined (not "restore"), strict mode rejected "--no-restore".
// The fix: name the option "restore" (default: true) so "--no-restore" correctly
// sets restore=false via yargs' built-in negation.

function buildCheckoutParser() {
  return yargs()
    .command(
      "checkout <branch>",
      "Check out a branch",
      (y) =>
        y
          .positional("branch", { type: "string", demandOption: true })
          .option("restore", {
            type: "boolean",
            default: true,
            describe: "Automatically restore stash on checkout (use --no-restore to skip)",
          }),
      () => {}
    )
    .strict()
    .help(false)
    .version(false);
}

describe("CLI arg parsing — BUG-004 --no-restore", () => {
  it("accepts --no-restore without strict-mode rejection", async () => {
    const parser = buildCheckoutParser();
    // Should not throw "Unknown argument: restore"
    const argv = await parser.parseAsync(["checkout", "main", "--no-restore"]);
    expect(argv.restore).toBe(false);
  });

  it("defaults restore to true when --no-restore is absent", async () => {
    const parser = buildCheckoutParser();
    const argv = await parser.parseAsync(["checkout", "main"]);
    expect(argv.restore).toBe(true);
  });

  it("accepts explicit --restore true (long form)", async () => {
    const parser = buildCheckoutParser();
    const argv = await parser.parseAsync(["checkout", "main", "--restore"]);
    expect(argv.restore).toBe(true);
  });
});
