import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createContainerStructure,
  currentSlotName,
  findContainer,
  validateContainer,
} from "../../src/core/container.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "wt-container-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("findContainer", () => {
  it("returns paths when called from container root", async () => {
    await mkdir(join(tmpDir, ".wt"));
    const result = await findContainer(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.container).toBe(resolve(tmpDir));
    expect(result!.wtDir).toBe(join(resolve(tmpDir), ".wt"));
    expect(result!.repoDir).toBe(join(resolve(tmpDir), ".wt", "repo"));
  });

  it("returns paths when called from inside a worktree slot", async () => {
    // container/
    //   .wt/
    //   my-slot/
    //     subdir/
    await mkdir(join(tmpDir, ".wt"));
    await mkdir(join(tmpDir, "my-slot", "subdir"), { recursive: true });

    const result = await findContainer(join(tmpDir, "my-slot", "subdir"));
    expect(result).not.toBeNull();
    expect(result!.container).toBe(resolve(tmpDir));
  });

  it("returns null when not inside a managed container", async () => {
    // tmpDir has no .wt/ directory
    const result = await findContainer(tmpDir);
    expect(result).toBeNull();
  });

  it("finds container when cwd is a slot at the container level", async () => {
    await mkdir(join(tmpDir, ".wt"));
    const slotDir = join(tmpDir, "some-slot");
    await mkdir(slotDir);

    const result = await findContainer(slotDir);
    expect(result).not.toBeNull();
    expect(result!.container).toBe(resolve(tmpDir));
  });
});

describe("createContainerStructure", () => {
  it("creates all expected subdirectories", async () => {
    const wtDir = await createContainerStructure(tmpDir);
    expect(wtDir).toBe(join(tmpDir, ".wt"));

    const { stat } = await import("node:fs/promises");
    const expected = [
      join(tmpDir, ".wt"),
      join(tmpDir, ".wt", "repo"),
      join(tmpDir, ".wt", "stashes"),
      join(tmpDir, ".wt", "stashes", "archive"),
      join(tmpDir, ".wt", "shared"),
      join(tmpDir, ".wt", "templates"),
      join(tmpDir, ".wt", "hooks"),
    ];

    for (const dir of expected) {
      const s = await stat(dir);
      expect(s.isDirectory()).toBe(true);
    }
  });

  it("is idempotent — does not throw if directories already exist", async () => {
    await createContainerStructure(tmpDir);
    await expect(createContainerStructure(tmpDir)).resolves.not.toThrow();
  });
});

describe("validateContainer", () => {
  it("resolves when .wt/repo/ exists", async () => {
    await mkdir(join(tmpDir, ".wt", "repo"), { recursive: true });
    const paths = {
      container: tmpDir,
      wtDir: join(tmpDir, ".wt"),
      repoDir: join(tmpDir, ".wt", "repo"),
    };
    await expect(validateContainer(paths)).resolves.toBeUndefined();
  });

  it("throws when .wt/repo/ is missing", async () => {
    await mkdir(join(tmpDir, ".wt"), { recursive: true });
    // .wt/repo/ intentionally absent
    const paths = {
      container: tmpDir,
      wtDir: join(tmpDir, ".wt"),
      repoDir: join(tmpDir, ".wt", "repo"),
    };
    await expect(validateContainer(paths)).rejects.toThrow(
      "Container is corrupted: .wt/repo/ is missing.",
    );
  });
});

describe("currentSlotName", () => {
  it("returns slot name when cwd is directly in a slot", async () => {
    await mkdir(join(tmpDir, ".wt"));
    const slotDir = join(tmpDir, "brave-tiger-oak");
    await mkdir(slotDir);

    const containerPaths = {
      container: tmpDir,
      wtDir: join(tmpDir, ".wt"),
      repoDir: join(tmpDir, ".wt", "repo"),
    };

    const name = currentSlotName(slotDir, containerPaths);
    expect(name).toBe("brave-tiger-oak");
  });

  it("returns slot name when cwd is deep inside a slot", async () => {
    await mkdir(join(tmpDir, ".wt"));
    const deepDir = join(tmpDir, "brave-tiger-oak", "src", "components");
    await mkdir(deepDir, { recursive: true });

    const containerPaths = {
      container: tmpDir,
      wtDir: join(tmpDir, ".wt"),
      repoDir: join(tmpDir, ".wt", "repo"),
    };

    const name = currentSlotName(deepDir, containerPaths);
    expect(name).toBe("brave-tiger-oak");
  });

  it("returns null when cwd is the container itself", async () => {
    const containerPaths = {
      container: tmpDir,
      wtDir: join(tmpDir, ".wt"),
      repoDir: join(tmpDir, ".wt", "repo"),
    };

    const name = currentSlotName(tmpDir, containerPaths);
    expect(name).toBeNull();
  });

  it("returns null when cwd is inside .wt", async () => {
    const containerPaths = {
      container: tmpDir,
      wtDir: join(tmpDir, ".wt"),
      repoDir: join(tmpDir, ".wt", "repo"),
    };

    const name = currentSlotName(join(tmpDir, ".wt"), containerPaths);
    expect(name).toBeNull();
  });
});
