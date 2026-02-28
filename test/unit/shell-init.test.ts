import { describe, expect, it } from "vitest";
import { runShellInit } from "../../src/commands/shell-init.js";

// BUG-003: shell function used `command -v wt` which returned the function name
// (not the binary path) once the function was eval'd, causing infinite recursion.
// The fix is to use `command wt` which bypasses shell functions directly.

describe("runShellInit", () => {
  it("bash script uses `command wt` to bypass the shell function and avoid recursion", () => {
    const script = runShellInit("bash");
    // Must NOT use `command -v wt` — that returns the function name, not binary path
    expect(script).not.toContain("command -v wt");
    // Must use `command wt` which bypasses functions and calls the binary directly
    expect(script).toContain("command wt");
  });

  it("zsh script uses `command wt` to bypass the shell function and avoid recursion", () => {
    const script = runShellInit("zsh");
    expect(script).not.toContain("command -v wt");
    expect(script).toContain("command wt");
  });

  it("fish script uses `command wt` to bypass the shell function and avoid recursion", () => {
    const script = runShellInit("fish");
    // Fish had same problem: `set -l wt_bin (command -v wt)` then `$wt_bin $argv`
    expect(script).not.toContain("command -v wt");
    expect(script).toContain("command wt");
  });

  it("bash script defines a wt() function", () => {
    const script = runShellInit("bash");
    expect(script).toMatch(/^wt\(\)/m);
  });

  it("fish script defines a `wt` function", () => {
    const script = runShellInit("fish");
    expect(script).toMatch(/^function wt/m);
  });
});
