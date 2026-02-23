import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { runCheckout } from "../../src/commands/checkout.js";
import { runList } from "../../src/commands/list.js";
import { readState } from "../../src/core/state.js";
import { createTempDir, createTestRepo, cleanup } from "./helpers.js";

const temps: string[] = [];

async function mktemp(): Promise<string> {
  const d = await createTempDir();
  temps.push(d);
  return d;
}

afterEach(async () => {
  for (const d of temps.splice(0)) {
    await cleanup(d);
  }
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    if (typeof chunk === "string") lines.push(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return lines.join("");
}

describe("wt list", () => {
  it("shows all slots with correct branch names and vacant markers", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);
    await runInit({ cwd: dir });

    const wtDir = path.join(dir, ".wt");
    const repoDir = path.join(dir, ".wt", "repo");
    const state = await readState(wtDir);
    const slotCount = Object.keys(state.slots).length;

    // Checkout a second branch to have a non-vacant slot
    await execa("git", ["branch", "feature-list"], { cwd: repoDir });
    await runCheckout({ branch: "feature-list", cwd: dir });

    const output = await captureStdout(() => runList({ cwd: dir }));

    // Header should be present
    expect(output).toContain("Slot");
    expect(output).toContain("Branch");
    expect(output).toContain("Status");

    // 'main' should appear
    expect(output).toContain("main");
    // 'feature-list' should appear
    expect(output).toContain("feature-list");
    // Some slots should be vacant
    expect(output).toContain("(vacant)");

    // Count rows (should match slot count + header + divider)
    const dataLines = output.split("\n").filter((l) => l.trim().length > 0);
    // header + divider + slotCount rows = slotCount + 2
    expect(dataLines.length).toBe(slotCount + 2);
  });

  it("shows 'clean' for a slot with no uncommitted changes", async () => {
    const dir = await mktemp();
    await createTestRepo(dir);
    await runInit({ cwd: dir });

    const output = await captureStdout(() => runList({ cwd: dir }));
    // The main slot should be clean
    expect(output).toContain("clean");
  });
});
