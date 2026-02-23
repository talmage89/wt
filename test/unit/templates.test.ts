import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  expandTemplate,
  generateTemplates,
} from "../../src/core/templates.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "wt-templates-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("expandTemplate", () => {
  it("replaces {{WORKTREE_DIR}}", () => {
    expect(
      expandTemplate("dir: {{WORKTREE_DIR}}", {
        WORKTREE_DIR: "amber-bay-creek",
        BRANCH_NAME: "main",
      })
    ).toBe("dir: amber-bay-creek");
  });

  it("replaces {{BRANCH_NAME}}", () => {
    expect(
      expandTemplate("branch: {{BRANCH_NAME}}", {
        WORKTREE_DIR: "slot",
        BRANCH_NAME: "feature/foo",
      })
    ).toBe("branch: feature/foo");
  });

  it("leaves unknown {{FOO}} variables as-is", () => {
    expect(
      expandTemplate("keep: {{UNKNOWN_VAR}}", {
        WORKTREE_DIR: "slot",
        BRANCH_NAME: "main",
      })
    ).toBe("keep: {{UNKNOWN_VAR}}");
  });

  it("handles multiple occurrences of the same variable", () => {
    expect(
      expandTemplate("{{BRANCH_NAME}} is {{BRANCH_NAME}}", {
        WORKTREE_DIR: "slot",
        BRANCH_NAME: "dev",
      })
    ).toBe("dev is dev");
  });

  it("passes through content with no variables", () => {
    const content = "no variables here\njust plain text";
    expect(
      expandTemplate(content, { WORKTREE_DIR: "slot", BRANCH_NAME: "main" })
    ).toBe(content);
  });

  it("replaces both variables in the same content", () => {
    const result = expandTemplate(
      "slot={{WORKTREE_DIR}} branch={{BRANCH_NAME}}",
      { WORKTREE_DIR: "my-slot", BRANCH_NAME: "my-branch" }
    );
    expect(result).toBe("slot=my-slot branch=my-branch");
  });
});

describe("generateTemplates", () => {
  it("writes template file to correct path", async () => {
    const wtDir = join(tmpDir, "wt");
    const worktreeDir = join(tmpDir, "slot");
    await mkdir(wtDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });

    await writeFile(join(wtDir, "env.tmpl"), "BRANCH={{BRANCH_NAME}}\n", "utf8");

    await generateTemplates(wtDir, worktreeDir, "my-slot", "main", [
      { source: "env.tmpl", target: ".env" },
    ]);

    const content = await readFile(join(worktreeDir, ".env"), "utf8");
    expect(content).toBe("BRANCH=main\n");
  });

  it("creates parent directories for the target", async () => {
    const wtDir = join(tmpDir, "wt");
    const worktreeDir = join(tmpDir, "slot");
    await mkdir(wtDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });

    await writeFile(join(wtDir, "deep.tmpl"), "content", "utf8");

    await generateTemplates(wtDir, worktreeDir, "slot", "main", [
      { source: "deep.tmpl", target: "config/deep/file.txt" },
    ]);

    const content = await readFile(
      join(worktreeDir, "config/deep/file.txt"),
      "utf8"
    );
    expect(content).toBe("content");
  });

  it("overwrites existing target file", async () => {
    const wtDir = join(tmpDir, "wt");
    const worktreeDir = join(tmpDir, "slot");
    await mkdir(wtDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });

    const targetPath = join(worktreeDir, ".env");
    await writeFile(targetPath, "OLD_CONTENT", "utf8");
    await writeFile(join(wtDir, "env.tmpl"), "NEW_CONTENT", "utf8");

    await generateTemplates(wtDir, worktreeDir, "slot", "main", [
      { source: "env.tmpl", target: ".env" },
    ]);

    const content = await readFile(targetPath, "utf8");
    expect(content).toBe("NEW_CONTENT");
  });

  it("skips and warns for missing source files", async () => {
    const wtDir = join(tmpDir, "wt");
    const worktreeDir = join(tmpDir, "slot");
    await mkdir(wtDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });

    // Should not throw, should emit a warning
    await expect(
      generateTemplates(wtDir, worktreeDir, "slot", "main", [
        { source: "nonexistent.tmpl", target: ".env" },
      ])
    ).resolves.not.toThrow();
  });
});
