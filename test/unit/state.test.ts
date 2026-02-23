import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readState, writeState, defaultState } from "../../src/core/state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "wt-state-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("defaultState", () => {
  it("returns empty state", () => {
    const s = defaultState();
    expect(s.slots).toEqual({});
    expect(s.branch_history).toEqual([]);
  });
});

describe("readState", () => {
  it("returns defaultState when file does not exist", async () => {
    const s = await readState(tmpDir);
    expect(s).toEqual(defaultState());
  });

  it("parses a state with multiple slots", async () => {
    const toml = `
[[branch_history]]
branch = "main"
last_checkout_at = "2024-01-01T00:00:00.000Z"

[[branch_history]]
branch = "feature/foo"
last_checkout_at = "2024-01-02T00:00:00.000Z"

[slots.amber-bay-creek]
last_used_at = "2024-01-02T00:00:00.000Z"
pinned = false
branch = "feature/foo"

[slots.birch-cove-dale]
last_used_at = "2024-01-01T00:00:00.000Z"
pinned = true
branch = "main"

[slots.cedar-drift-eden]
last_used_at = "2024-01-01T00:00:00.000Z"
pinned = false
`;
    await writeFile(join(tmpDir, "state.toml"), toml, "utf8");
    const s = await readState(tmpDir);

    expect(Object.keys(s.slots)).toHaveLength(3);
    expect(s.slots["amber-bay-creek"].branch).toBe("feature/foo");
    expect(s.slots["amber-bay-creek"].pinned).toBe(false);
    expect(s.slots["birch-cove-dale"].pinned).toBe(true);
    expect(s.slots["birch-cove-dale"].branch).toBe("main");
  });

  it("treats missing branch key as null (vacant slot)", async () => {
    const toml = `
[slots.empty-slot-name]
last_used_at = "2024-01-01T00:00:00.000Z"
pinned = false
`;
    await writeFile(join(tmpDir, "state.toml"), toml, "utf8");
    const s = await readState(tmpDir);
    expect(s.slots["empty-slot-name"].branch).toBeNull();
  });

  it("preserves branch_history order", async () => {
    const toml = `
[[branch_history]]
branch = "first"
last_checkout_at = "2024-01-01T00:00:00.000Z"

[[branch_history]]
branch = "second"
last_checkout_at = "2024-01-02T00:00:00.000Z"

[[branch_history]]
branch = "third"
last_checkout_at = "2024-01-03T00:00:00.000Z"
`;
    await writeFile(join(tmpDir, "state.toml"), toml, "utf8");
    const s = await readState(tmpDir);
    expect(s.branch_history.map((e) => e.branch)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("writeState / round-trip", () => {
  it("round-trips a state with active and vacant slots", async () => {
    const state = {
      slots: {
        "slot-one": {
          branch: "main",
          last_used_at: "2024-06-01T12:00:00.000Z",
          pinned: true,
        },
        "slot-two": {
          branch: null,
          last_used_at: "2024-06-01T10:00:00.000Z",
          pinned: false,
        },
      },
      branch_history: [
        { branch: "main", last_checkout_at: "2024-06-01T12:00:00.000Z" },
      ],
    };
    await writeState(tmpDir, state);
    const loaded = await readState(tmpDir);

    expect(loaded.slots["slot-one"].branch).toBe("main");
    expect(loaded.slots["slot-one"].pinned).toBe(true);
    expect(loaded.slots["slot-two"].branch).toBeNull();
    expect(loaded.slots["slot-two"].pinned).toBe(false);
    expect(loaded.branch_history).toHaveLength(1);
    expect(loaded.branch_history[0].branch).toBe("main");
  });
});
