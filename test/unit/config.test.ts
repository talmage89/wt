import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  readConfig,
  writeConfig,
  defaultConfig,
} from "../../src/core/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "wt-config-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("defaultConfig", () => {
  it("returns correct default values", () => {
    const cfg = defaultConfig();
    expect(cfg.slot_count).toBe(5);
    expect(cfg.archive_after_days).toBe(7);
    expect(cfg.shared.directories).toEqual([]);
    expect(cfg.templates).toEqual([]);
  });
});

describe("readConfig", () => {
  it("returns defaultConfig when file does not exist", async () => {
    const cfg = await readConfig(tmpDir);
    expect(cfg).toEqual(defaultConfig());
  });

  it("parses a full config correctly", async () => {
    const toml = `
slot_count = 3
archive_after_days = 14

[shared]
directories = ["node_modules", ".env"]

[[templates]]
source = "templates/env.tmpl"
target = ".env"

[[templates]]
source = "templates/makefile.tmpl"
target = "Makefile"
`;
    await writeFile(join(tmpDir, "config.toml"), toml, "utf8");
    const cfg = await readConfig(tmpDir);
    expect(cfg.slot_count).toBe(3);
    expect(cfg.archive_after_days).toBe(14);
    expect(cfg.shared.directories).toEqual(["node_modules", ".env"]);
    expect(cfg.templates).toHaveLength(2);
    expect(cfg.templates[0]).toEqual({
      source: "templates/env.tmpl",
      target: ".env",
    });
    expect(cfg.templates[1]).toEqual({
      source: "templates/makefile.tmpl",
      target: "Makefile",
    });
  });

  it("fills missing optional fields with defaults", async () => {
    const toml = `slot_count = 8\n`;
    await writeFile(join(tmpDir, "config.toml"), toml, "utf8");
    const cfg = await readConfig(tmpDir);
    expect(cfg.slot_count).toBe(8);
    expect(cfg.archive_after_days).toBe(7);
    expect(cfg.shared.directories).toEqual([]);
    expect(cfg.templates).toEqual([]);
  });
});

describe("writeConfig / round-trip", () => {
  it("round-trips a config through TOML", async () => {
    const original = {
      slot_count: 4,
      archive_after_days: 30,
      shared: { directories: ["vendor"] },
      templates: [{ source: "src.tmpl", target: "dest.txt" }],
    };
    await writeConfig(tmpDir, original);
    const loaded = await readConfig(tmpDir);
    expect(loaded.slot_count).toBe(4);
    expect(loaded.archive_after_days).toBe(30);
    expect(loaded.shared.directories).toEqual(["vendor"]);
    expect(loaded.templates).toEqual([{ source: "src.tmpl", target: "dest.txt" }]);
  });

  it("produces valid TOML output", async () => {
    await writeConfig(tmpDir, defaultConfig());
    // If readConfig succeeds without throwing, the TOML is valid
    const cfg = await readConfig(tmpDir);
    expect(cfg).toEqual(defaultConfig());
  });
});
