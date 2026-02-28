import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, readConfig, writeConfig } from "../../src/core/config.js";

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
    expect(cfg.fetch_cooldown_minutes).toBe(10);
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
    expect(cfg.fetch_cooldown_minutes).toBe(10);
    expect(cfg.shared.directories).toEqual([]);
    expect(cfg.templates).toEqual([]);
  });

  it("parses fetch_cooldown_minutes from config", async () => {
    const toml = `fetch_cooldown_minutes = 5\n`;
    await writeFile(join(tmpDir, "config.toml"), toml, "utf8");
    const cfg = await readConfig(tmpDir);
    expect(cfg.fetch_cooldown_minutes).toBe(5);
  });
});

describe("writeConfig / round-trip", () => {
  it("round-trips a config through TOML", async () => {
    const original = {
      slot_count: 4,
      archive_after_days: 30,
      fetch_cooldown_minutes: 15,
      shared: { directories: ["vendor"] },
      templates: [{ source: "src.tmpl", target: "dest.txt" }],
    };
    await writeConfig(tmpDir, original);
    const loaded = await readConfig(tmpDir);
    expect(loaded.slot_count).toBe(4);
    expect(loaded.archive_after_days).toBe(30);
    expect(loaded.fetch_cooldown_minutes).toBe(15);
    expect(loaded.shared.directories).toEqual(["vendor"]);
    expect(loaded.templates).toEqual([{ source: "src.tmpl", target: "dest.txt" }]);
  });

  it("produces valid TOML output", async () => {
    await writeConfig(tmpDir, defaultConfig());
    // If readConfig succeeds without throwing, the TOML is valid
    const cfg = await readConfig(tmpDir);
    expect(cfg).toEqual(defaultConfig());
  });

  it("writeConfig with empty templates allows appending [[templates]] (BUG-013)", async () => {
    // Write a default config (empty templates)
    await writeConfig(tmpDir, defaultConfig());

    // The generated TOML must NOT contain "templates = []"
    const raw = await readFile(join(tmpDir, "config.toml"), "utf8");
    expect(raw).not.toContain("templates");

    // User appends [[templates]] per VISION §10 syntax
    await appendFile(
      join(tmpDir, "config.toml"),
      `\n[[templates]]\nsource = "templates/env.test"\ntarget = ".env.test"\n`,
      "utf8",
    );

    // readConfig must parse without error and return the template
    const cfg = await readConfig(tmpDir);
    expect(cfg.templates).toEqual([{ source: "templates/env.test", target: ".env.test" }]);
  });
});
