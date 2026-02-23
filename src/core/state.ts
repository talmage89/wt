import { parse, stringify } from "smol-toml";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

export interface SlotState {
  branch: string | null;   // null = vacant (detached HEAD)
  last_used_at: string;    // ISO 8601 timestamp
  pinned: boolean;
}

export interface BranchHistoryEntry {
  branch: string;
  last_checkout_at: string; // ISO 8601
}

export interface State {
  slots: Record<string, SlotState>;    // keyed by slot directory name
  branch_history: BranchHistoryEntry[]; // ordered by recency (most recent first)
}

/**
 * Return empty/default state.
 */
export function defaultState(): State {
  return {
    slots: {},
    branch_history: [],
  };
}

/**
 * Read state from .wt/state.toml. Returns defaultState() if file is missing.
 */
export async function readState(wtDir: string): Promise<State> {
  const statePath = join(wtDir, "state.toml");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState();
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw) as Record<string, unknown>;
  } catch {
    process.stderr.write(
      "Warning: .wt/state.toml is corrupted. Regenerating from git state.\n"
    );
    return defaultState();
  }

  const slots: Record<string, SlotState> = {};
  if (parsed["slots"] && typeof parsed["slots"] === "object") {
    const slotsRaw = parsed["slots"] as Record<string, Record<string, unknown>>;
    for (const [name, slot] of Object.entries(slotsRaw)) {
      slots[name] = {
        branch:
          slot["branch"] === null || slot["branch"] === undefined
            ? null
            : typeof slot["branch"] === "string"
            ? slot["branch"]
            : null,
        last_used_at:
          typeof slot["last_used_at"] === "string"
            ? slot["last_used_at"]
            : new Date(0).toISOString(),
        pinned: typeof slot["pinned"] === "boolean" ? slot["pinned"] : false,
      };
    }
  }

  const branch_history: BranchHistoryEntry[] = [];
  if (Array.isArray(parsed["branch_history"])) {
    for (const entry of parsed["branch_history"] as Record<
      string,
      unknown
    >[]) {
      if (
        typeof entry["branch"] === "string" &&
        typeof entry["last_checkout_at"] === "string"
      ) {
        branch_history.push({
          branch: entry["branch"],
          last_checkout_at: entry["last_checkout_at"],
        });
      }
    }
  }

  return { slots, branch_history };
}

/**
 * Write state to .wt/state.toml.
 */
export async function writeState(wtDir: string, state: State): Promise<void> {
  const statePath = join(wtDir, "state.toml");

  // smol-toml needs plain objects; build a serializable form
  // Represent null branch as empty string for TOML, decode back on read
  // Actually TOML supports null via empty string trick, but smol-toml may handle it.
  // Use a sentinel approach: store branch as string, use "" for null.
  // Wait - the spec says branch: string | null. Let's check if smol-toml handles null.
  // smol-toml does handle null values (they become null in TOML via empty value or special).
  // Actually TOML doesn't have null. We'll use a "vacant" sentinel or omit the key.
  // Best approach: use a separate boolean "vacant" or use an empty string to mean null.
  // Per the interface, null means vacant. We'll encode null as absent (no branch key).

  const slotsData: Record<string, Record<string, unknown>> = {};
  for (const [name, slot] of Object.entries(state.slots)) {
    const slotData: Record<string, unknown> = {
      last_used_at: slot.last_used_at,
      pinned: slot.pinned,
    };
    if (slot.branch !== null) {
      slotData["branch"] = slot.branch;
    }
    // If branch is null, we omit the key; readState will interpret missing key as null
    slotsData[name] = slotData;
  }

  const data: Record<string, unknown> = {
    slots: slotsData,
    branch_history: state.branch_history,
  };

  await writeFile(statePath, stringify(data), "utf8");
}
