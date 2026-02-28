import { randomInt } from "node:crypto";

const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a unique 4-character alphanumeric slot name not in `existingNames`.
 * Uses cryptographically random selection (crypto.randomInt).
 * Format: 4 lowercase alphanumeric characters (a-z0-9).
 */
export function generateSlotName(existingNames: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let name = "";
    for (let i = 0; i < 4; i++) {
      name += CHARSET[randomInt(CHARSET.length)];
    }
    if (!existingNames.has(name)) {
      return name;
    }
  }
  throw new Error("generateSlotName: exhausted 100 attempts");
}
