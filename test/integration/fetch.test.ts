import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { runInit } from "../../src/commands/init.js";
import { runFetch } from "../../src/commands/fetch.js";
import {
  createTempDir,
  createBareRemote,
  cleanup,
} from "./helpers.js";

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

describe("wt fetch", () => {
  it("updates remote-tracking branches after new commits on the remote", async () => {
    // Create a bare remote
    const remoteBase = await mktemp();
    const remoteDir = path.join(remoteBase, "remote.git");
    await createBareRemote(remoteDir);

    // Init container from the bare remote
    const containerDir = await mktemp();
    await runInit({ url: remoteDir, cwd: containerDir });

    const repoDir = path.join(containerDir, ".wt", "repo");

    // Capture the current tip of origin/main before adding new commits
    const beforeLog = (
      await execa("git", ["log", "--oneline", "origin/main"], { cwd: repoDir })
    ).stdout.trim();
    const beforeLineCount = beforeLog.split("\n").length;

    // Add a new commit to the bare remote by cloning it, committing, and pushing
    const workDir = await createTempDir();
    temps.push(workDir);
    await execa("git", ["clone", remoteDir, workDir]);
    await execa("git", ["config", "user.email", "test@wt.test"], { cwd: workDir });
    await execa("git", ["config", "user.name", "WT Test"], { cwd: workDir });
    await fs.writeFile(path.join(workDir, "new-file.txt"), "new content\n");
    await execa("git", ["add", "."], { cwd: workDir });
    await execa("git", ["commit", "-m", "New remote commit"], { cwd: workDir });
    await execa("git", ["push", "origin", "main"], { cwd: workDir });

    // Verify the new commit is NOT yet visible in origin/main
    const beforeFetchLog = (
      await execa("git", ["log", "--oneline", "origin/main"], { cwd: repoDir })
    ).stdout.trim();
    expect(beforeFetchLog.split("\n").length).toBe(beforeLineCount);

    // Run wt fetch
    await runFetch({ cwd: containerDir });

    // Verify the new commit IS now visible in origin/main
    const afterLog = (
      await execa("git", ["log", "--oneline", "origin/main"], { cwd: repoDir })
    ).stdout.trim();
    expect(afterLog.split("\n").length).toBe(beforeLineCount + 1);
    expect(afterLog).toContain("New remote commit");
  });
});
