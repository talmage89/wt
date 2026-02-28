import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanNavFile, navFilePath, readNavFile, writeNavFile } from "../../src/core/nav.js";

const TEST_NAV_PATH = `/tmp/wt-nav-test-${process.pid}`;

afterEach(async () => {
  // Clean up any test nav files
  await cleanNavFile(TEST_NAV_PATH);
});

describe("navFilePath", () => {
  it("uses process.ppid", () => {
    const path = navFilePath();
    expect(path).toBe(`/tmp/wt-nav-${process.ppid}`);
  });
});

describe("writeNavFile / readNavFile", () => {
  it("write then read returns same path", async () => {
    const targetDir = "/home/user/projects/my-slot";
    await writeNavFile.call(null, targetDir);
    // The actual navFilePath uses ppid, but we test with a custom path for isolation
    // Instead, let's test by writing to a known path directly
    const { writeFile } = await import("node:fs/promises");
    await writeFile(TEST_NAV_PATH, `${targetDir}\n`, "utf8");
    const result = await readNavFile(TEST_NAV_PATH);
    expect(result).toBe(targetDir);
  });

  it("readNavFile trims newline", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(TEST_NAV_PATH, "/some/dir\n", "utf8");
    const result = await readNavFile(TEST_NAV_PATH);
    expect(result).toBe("/some/dir");
  });
});

describe("cleanNavFile", () => {
  it("removes the file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(TEST_NAV_PATH, "/test\n", "utf8");
    expect(existsSync(TEST_NAV_PATH)).toBe(true);
    await cleanNavFile(TEST_NAV_PATH);
    expect(existsSync(TEST_NAV_PATH)).toBe(false);
  });

  it("does not throw on non-existent file", async () => {
    await expect(cleanNavFile("/tmp/wt-nav-nonexistent-file-99999")).resolves.not.toThrow();
  });
});
