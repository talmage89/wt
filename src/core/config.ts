import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

export interface TemplateConfig {
  source: string; // relative to .wt/
  target: string; // relative to worktree root
}

export interface SharedConfig {
  directories: string[]; // directory paths relative to worktree root (recursive)
  files: string[]; // individual file paths relative to worktree root
}

export interface Config {
  slot_count: number; // default: 5
  archive_after_days: number; // default: 7
  fetch_cooldown_minutes: number; // default: 10
  shared: SharedConfig;
  templates: TemplateConfig[];
}

/**
 * Return a Config with all defaults.
 */
export function defaultConfig(): Config {
  return {
    slot_count: 5,
    archive_after_days: 7,
    fetch_cooldown_minutes: 10,
    shared: { directories: [], files: [] },
    templates: [],
  };
}

/**
 * Read config from .wt/config.toml. Returns defaults for missing fields.
 * Missing file → returns defaultConfig().
 */
export async function readConfig(wtDir: string): Promise<Config> {
  const configPath = join(wtDir, "config.toml");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    throw err;
  }

  const parsed = parse(raw) as Record<string, unknown>;
  const defaults = defaultConfig();

  const slot_count =
    typeof parsed.slot_count === "number" ? parsed.slot_count : defaults.slot_count;
  const archive_after_days =
    typeof parsed.archive_after_days === "number"
      ? parsed.archive_after_days
      : defaults.archive_after_days;
  const fetch_cooldown_minutes =
    typeof parsed.fetch_cooldown_minutes === "number"
      ? parsed.fetch_cooldown_minutes
      : defaults.fetch_cooldown_minutes;

  let shared: SharedConfig = defaults.shared;
  if (parsed.shared && typeof parsed.shared === "object") {
    const sharedRaw = parsed.shared as Record<string, unknown>;
    shared = {
      directories: Array.isArray(sharedRaw.directories) ? (sharedRaw.directories as string[]) : [],
      files: Array.isArray(sharedRaw.files) ? (sharedRaw.files as string[]) : [],
    };
  }

  let templates: TemplateConfig[] = defaults.templates;
  if (Array.isArray(parsed.templates)) {
    templates = (parsed.templates as Record<string, unknown>[]).map((t) => ({
      source: typeof t.source === "string" ? t.source : "",
      target: typeof t.target === "string" ? t.target : "",
    }));
  }

  return { slot_count, archive_after_days, fetch_cooldown_minutes, shared, templates };
}

/**
 * Write config to .wt/config.toml.
 */
export async function writeConfig(wtDir: string, config: Config): Promise<void> {
  const configPath = join(wtDir, "config.toml");
  const data: Record<string, unknown> = {
    slot_count: config.slot_count,
    archive_after_days: config.archive_after_days,
    fetch_cooldown_minutes: config.fetch_cooldown_minutes,
    shared: { directories: config.shared.directories, files: config.shared.files },
  };
  if (config.templates.length > 0) {
    data.templates = config.templates;
  }
  await writeFile(configPath, stringify(data), "utf8");
}
