import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../src/core/lock.js";

const temps: string[] = [];

async function mktemp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "wt-lock-test-"));
  temps.push(d);
  return d;
}

afterEach(async () => {
  for (const d of temps.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe("acquireLock", () => {
  it("creates a lock file and returns a release function", async () => {
    const wtDir = await mktemp();
    const lockPath = path.join(wtDir, "lock");

    const release = await acquireLock(wtDir);

    // Lock file should exist
    const stat = await fs.stat(lockPath);
    expect(stat.isFile()).toBe(true);

    // Lock file should contain the PID
    const content = await fs.readFile(lockPath, "utf8");
    expect(content).toBe(String(process.pid));

    await release();

    // Lock file should be gone after release
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("throws when lock is already held", async () => {
    const wtDir = await mktemp();

    const release = await acquireLock(wtDir);
    try {
      await expect(acquireLock(wtDir)).rejects.toThrow(
        "Another wt operation is in progress. If this is stale, remove .wt/lock.",
      );
    } finally {
      await release();
    }
  });

  it("allows re-acquisition after release", async () => {
    const wtDir = await mktemp();

    const release1 = await acquireLock(wtDir);
    await release1();

    // Should succeed after the first lock is released
    const release2 = await acquireLock(wtDir);
    await release2();
  });

  it("release is idempotent (no error on double-release)", async () => {
    const wtDir = await mktemp();
    const release = await acquireLock(wtDir);
    await release();
    // Second release should not throw
    await expect(release()).resolves.toBeUndefined();
  });
});
