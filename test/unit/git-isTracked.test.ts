import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { isTracked } from "../../src/core/git.js";

const temps: string[] = [];

async function mktemp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "wt-git-test-"));
  temps.push(d);
  return d;
}

afterEach(async () => {
  for (const d of temps.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function initRepo(dir: string): Promise<void> {
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  await execa("git", ["config", "user.name", "T"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# test\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "init"], { cwd: dir });
}

describe("isTracked (BUG-005 / BUG-006 regression)", () => {
  it("returns true for a git-tracked file", async () => {
    const dir = await mktemp();
    await initRepo(dir);

    const result = await isTracked(dir, "README.md");
    expect(result).toBe(true);
  });

  it("returns false for an untracked file without leaking git stderr", async () => {
    const dir = await mktemp();
    await initRepo(dir);

    await fs.writeFile(path.join(dir, "untracked.txt"), "not committed\n");

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    let result: boolean;
    try {
      result = await isTracked(dir, "untracked.txt");
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result).toBe(false);
    // Must not emit the "did not match any file(s) known to git" error
    const stderr = stderrChunks.join("");
    expect(stderr).not.toContain("error:");
    expect(stderr).not.toContain("did not match");
  });
});
