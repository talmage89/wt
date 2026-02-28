import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/commands/init.js";
import { runList } from "../../src/commands/list.js";
import { readConfig, writeConfig } from "../../src/core/config.js";
import { adjustSlotCount } from "../../src/core/slots.js";
import { readState, writeState } from "../../src/core/state.js";
import { cleanup, createTempDir, createTestRepo, exists } from "./helpers.js";

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

async function setupContainer(dir: string) {
  await createTestRepo(dir);
  await runInit({ cwd: dir });
  return {
    containerDir: dir,
    wtDir: path.join(dir, ".wt"),
    repoDir: path.join(dir, ".wt", "repo"),
  };
}

describe("adjustSlotCount — increase", () => {
  it("creates new vacant slots when slot_count increases", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const state = await readState(wtDir);
    const config = await readConfig(wtDir);
    const initialCount = Object.keys(state.slots).length;
    expect(initialCount).toBe(5); // default

    // Increase to 7
    config.slot_count = 7;
    const newState = await adjustSlotCount(repoDir, containerDir, wtDir, state, config);

    expect(Object.keys(newState.slots).length).toBe(7);
    // All new slots are vacant
    const slotEntries = Object.entries(newState.slots);
    const vacantSlots = slotEntries.filter(([, s]) => s.branch === null);
    expect(vacantSlots.length).toBeGreaterThanOrEqual(4); // 4 existing vacant + 2 new

    // Verify directories actually exist
    for (const [name] of slotEntries) {
      const slotPath = path.join(containerDir, name);
      expect(await exists(slotPath)).toBe(true);
    }
  });

  it("detects slot_count increase via wt list", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    // Bump slot_count in config file
    const config = await readConfig(wtDir);
    config.slot_count = 6;
    await writeConfig(wtDir, config);

    // wt list should trigger adjustSlotCount
    await runList({ cwd: containerDir });

    const state = await readState(wtDir);
    expect(Object.keys(state.slots).length).toBe(6);
  });
});

describe("adjustSlotCount — decrease", () => {
  it("removes excess vacant slots when slot_count decreases", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    const state = await readState(wtDir);
    expect(Object.keys(state.slots).length).toBe(5);

    const config = await readConfig(wtDir);
    config.slot_count = 3;
    const newState = await adjustSlotCount(repoDir, containerDir, wtDir, state, config);

    expect(Object.keys(newState.slots).length).toBe(3);

    // Removed slot directories should be gone
    const allSlotDirs = await fs.readdir(containerDir);
    const slotDirs = allSlotDirs.filter((d) => d !== ".wt");
    expect(slotDirs.length).toBe(3);
  });

  it("detects slot_count decrease via wt list", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    const config = await readConfig(wtDir);
    config.slot_count = 3;
    await writeConfig(wtDir, config);

    await runList({ cwd: containerDir });

    const state = await readState(wtDir);
    expect(Object.keys(state.slots).length).toBe(3);
  });

  it("evicts LRU slots when decreasing", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Manipulate timestamps: make slot[0] the most recently used
    const state = await readState(wtDir);
    const slotNames = Object.keys(state.slots);
    const recentSlot = slotNames[0];

    // Set slot[0] as most recent, others as older
    state.slots[slotNames[0]].last_used_at = new Date(Date.now() + 10000).toISOString();
    for (let i = 1; i < slotNames.length; i++) {
      state.slots[slotNames[i]].last_used_at = new Date(i * 1000).toISOString();
    }
    await writeState(wtDir, state);

    const config = await readConfig(wtDir);
    config.slot_count = 1;
    const newState = await adjustSlotCount(repoDir, containerDir, wtDir, state, config);

    expect(Object.keys(newState.slots).length).toBe(1);
    // The most recently used slot should survive
    expect(Object.keys(newState.slots)[0]).toBe(recentSlot);
  });

  it("throws when pinned count exceeds new slot count", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir, repoDir } = await setupContainer(dir);

    // Pin 3 slots
    const state = await readState(wtDir);
    const slotNames = Object.keys(state.slots);
    state.slots[slotNames[0]].pinned = true;
    state.slots[slotNames[1]].pinned = true;
    state.slots[slotNames[2]].pinned = true;
    await writeState(wtDir, state);

    const config = await readConfig(wtDir);
    config.slot_count = 2; // 3 pinned > 2 target

    await expect(adjustSlotCount(repoDir, containerDir, wtDir, state, config)).rejects.toThrow(
      "Cannot reduce slot count to 2: 3 worktrees are pinned",
    );
  });

  it("saves stash when evicting a dirty slot", async () => {
    const dir = await mktemp();
    const { containerDir, wtDir } = await setupContainer(dir);

    // Find the slot with 'main' checked out
    const state = await readState(wtDir);
    const mainEntry = Object.entries(state.slots).find(([, s]) => s.branch === "main");
    expect(mainEntry).toBeTruthy();
    const [mainSlot] = mainEntry!;
    const mainSlotDir = path.join(containerDir, mainSlot);

    // Create dirty state in the main slot by modifying a tracked file
    await fs.writeFile(path.join(mainSlotDir, "README.md"), "modified content");

    // Make main slot the LRU by backdating its timestamp
    state.slots[mainSlot].last_used_at = new Date(0).toISOString();
    await writeState(wtDir, state);

    // Decrease to 4 (evict 1 slot — should be main since it's LRU)
    const config = await readConfig(wtDir);
    config.slot_count = 4;
    const newState = await adjustSlotCount(
      path.join(dir, ".wt", "repo"),
      containerDir,
      wtDir,
      state,
      config,
    );

    // Slot was evicted
    expect(Object.keys(newState.slots).length).toBe(4);
    expect(newState.slots[mainSlot]).toBeUndefined();

    // Stash metadata should exist for main
    const stashFile = path.join(wtDir, "stashes", `main.toml`);
    expect(await exists(stashFile)).toBe(true);
  });
});
