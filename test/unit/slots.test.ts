import { describe, it, expect } from "vitest";
import {
  findSlotForBranch,
  selectSlotForCheckout,
  isVacant,
  markSlotUsed,
  markSlotVacant,
} from "../../src/core/slots.js";
import type { State, SlotState } from "../../src/core/state.js";

function makeSlot(
  branch: string | null,
  last_used_at: string,
  pinned = false
): SlotState {
  return { branch, last_used_at, pinned };
}

function makeState(slots: Record<string, SlotState>): State {
  return { slots, branch_history: [] };
}

describe("findSlotForBranch", () => {
  it("returns slot name when branch matches", () => {
    const state = makeState({
      "slot-a": makeSlot("main", "2024-01-01T00:00:00.000Z"),
      "slot-b": makeSlot("feature/foo", "2024-01-02T00:00:00.000Z"),
    });
    expect(findSlotForBranch(state, "feature/foo")).toBe("slot-b");
  });

  it("returns null when branch is not in any slot", () => {
    const state = makeState({
      "slot-a": makeSlot("main", "2024-01-01T00:00:00.000Z"),
    });
    expect(findSlotForBranch(state, "nonexistent")).toBeNull();
  });

  it("returns null when all slots are vacant", () => {
    const state = makeState({
      "slot-a": makeSlot(null, "2024-01-01T00:00:00.000Z"),
    });
    expect(findSlotForBranch(state, "main")).toBeNull();
  });
});

describe("isVacant", () => {
  it("returns true for slot with null branch", () => {
    expect(isVacant(makeSlot(null, "2024-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("returns false for slot with a branch", () => {
    expect(isVacant(makeSlot("main", "2024-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("selectSlotForCheckout", () => {
  it("prefers vacant slot over used ones", () => {
    const state = makeState({
      "slot-a": makeSlot("main", "2024-01-03T00:00:00.000Z"),
      "slot-b": makeSlot(null, "2024-01-01T00:00:00.000Z"), // vacant
      "slot-c": makeSlot("dev", "2024-01-02T00:00:00.000Z"),
    });
    expect(selectSlotForCheckout(state)).toBe("slot-b");
  });

  it("falls back to LRU non-pinned slot when no vacant slots", () => {
    const state = makeState({
      "slot-a": makeSlot("main", "2024-01-03T00:00:00.000Z"),
      "slot-b": makeSlot("dev", "2024-01-01T00:00:00.000Z"), // oldest
      "slot-c": makeSlot("feat", "2024-01-02T00:00:00.000Z"),
    });
    expect(selectSlotForCheckout(state)).toBe("slot-b");
  });

  it("skips pinned slots when selecting LRU", () => {
    const state = makeState({
      "slot-a": makeSlot("main", "2024-01-01T00:00:00.000Z", true), // oldest but pinned
      "slot-b": makeSlot("dev", "2024-01-03T00:00:00.000Z"),
      "slot-c": makeSlot("feat", "2024-01-02T00:00:00.000Z"), // oldest non-pinned
    });
    expect(selectSlotForCheckout(state)).toBe("slot-c");
  });

  it("throws when all non-vacant slots are pinned", () => {
    const state = makeState({
      "slot-a": makeSlot("main", "2024-01-01T00:00:00.000Z", true),
      "slot-b": makeSlot("dev", "2024-01-02T00:00:00.000Z", true),
    });
    expect(() => selectSlotForCheckout(state)).toThrow(
      "All worktree slots are pinned"
    );
  });
});

describe("markSlotUsed", () => {
  it("updates branch and timestamp", () => {
    const state = makeState({
      "slot-a": makeSlot(null, "2024-01-01T00:00:00.000Z"),
    });
    const before = new Date();
    markSlotUsed(state, "slot-a", "feature/bar");
    const after = new Date();

    expect(state.slots["slot-a"].branch).toBe("feature/bar");
    const usedAt = new Date(state.slots["slot-a"].last_used_at);
    expect(usedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("throws for unknown slot", () => {
    const state = makeState({});
    expect(() => markSlotUsed(state, "nonexistent", "main")).toThrow(
      "Slot not found"
    );
  });
});

describe("markSlotVacant", () => {
  it("clears the branch", () => {
    const state = makeState({
      "slot-a": makeSlot("main", "2024-01-01T00:00:00.000Z"),
    });
    markSlotVacant(state, "slot-a");
    expect(state.slots["slot-a"].branch).toBeNull();
  });

  it("throws for unknown slot", () => {
    const state = makeState({});
    expect(() => markSlotVacant(state, "nonexistent")).toThrow("Slot not found");
  });
});
