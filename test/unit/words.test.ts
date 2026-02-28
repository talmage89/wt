import { describe, expect, it } from "vitest";
import { generateSlotName } from "../../src/core/words.js";

describe("generateSlotName", () => {
  it("returns a 4-character lowercase alphanumeric name", () => {
    const name = generateSlotName(new Set());
    expect(name).toMatch(/^[a-z0-9]{4}$/);
  });

  it("two consecutive calls produce different names (probabilistically)", () => {
    const name1 = generateSlotName(new Set());
    const name2 = generateSlotName(new Set([name1]));
    expect(name1).not.toBe(name2);
  });

  it("avoids names in existingNames", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const name = generateSlotName(existing);
      expect(existing.has(name)).toBe(false);
      existing.add(name);
    }
  });
});
