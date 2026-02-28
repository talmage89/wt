import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { runCheckout } from "../../src/commands/checkout.js";
import { runInit } from "../../src/commands/init.js";
import { runPin, runUnpin } from "../../src/commands/pin.js";
import { readState, writeState } from "../../src/core/state.js";
import { cleanup, createTempDir, createTestRepo } from "./helpers.js";

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

describe("wt pin", () => {
  it("pins a slot by name and persists to state", async () => {
    const dir = await mktemp();
    const { wtDir } = await setupContainer(dir);

    const state = await readState(wtDir);
    const slotName = Object.keys(state.slots)[0];
    expect(state.slots[slotName].pinned).toBe(false);

    await runPin(slotName, { cwd: dir });

    const newState = await readState(wtDir);
    expect(newState.slots[slotName].pinned).toBe(true);
  });

  it("unpins a previously pinned slot", async () => {
    const dir = await mktemp();
    const { wtDir } = await setupContainer(dir);

    const state = await readState(wtDir);
    const slotName = Object.keys(state.slots)[0];

    // Pin it first via state write
    state.slots[slotName].pinned = true;
    await writeState(wtDir, state);

    await runUnpin(slotName, { cwd: dir });

    const newState = await readState(wtDir);
    expect(newState.slots[slotName].pinned).toBe(false);
  });

  it("throws on a non-existent slot name", async () => {
    const dir = await mktemp();
    await setupContainer(dir);

    await expect(runPin("nonexistent-slot-xyz", { cwd: dir })).rejects.toThrow("not found");
  });

  it("pinned slot is not evicted when all slots are occupied", async () => {
    const dir = await mktemp();
    await setupContainer(dir);

    const wtDir = path.join(dir, ".wt");
    const repoDir = path.join(dir, ".wt", "repo");

    // Find the slot with 'main'
    const stateBefore = await readState(wtDir);
    const slotNames = Object.keys(stateBefore.slots);
    const mainSlot = Object.entries(stateBefore.slots).find(([, s]) => s.branch === "main")?.[0];
    expect(mainSlot).toBeDefined();

    // Fill all remaining vacant slots so all 5 are occupied
    const vacantCount = slotNames.length - 1; // main is already one
    for (let i = 0; i < vacantCount; i++) {
      await execa("git", ["branch", `fill-branch-${i}`], { cwd: repoDir });
      await runCheckout({ branch: `fill-branch-${i}`, cwd: dir });
    }

    // Pin the main slot
    await runPin(mainSlot!, { cwd: dir });

    // Checkout one more branch — should evict an LRU non-pinned slot, NOT main
    await execa("git", ["branch", "eviction-target"], { cwd: repoDir });
    await runCheckout({ branch: "eviction-target", cwd: dir });

    const stateAfter = await readState(wtDir);
    // main slot should still have 'main'
    expect(stateAfter.slots[mainSlot!].branch).toBe("main");
    // eviction-target should be in some slot
    const targetSlot = Object.values(stateAfter.slots).find((s) => s.branch === "eviction-target");
    expect(targetSlot).toBeDefined();
  });
});
