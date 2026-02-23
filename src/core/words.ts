import { randomInt } from "crypto";
import { WORDS } from "../data/words.js";

/**
 * Generate a unique 3-word hyphenated name not in `existingNames`.
 * Uses cryptographically random selection (crypto.randomInt).
 * Format: word1-word2-word3 (all lowercase, hyphen-separated).
 */
export function generateSlotName(existingNames: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const w1 = WORDS[randomInt(WORDS.length)];
    const w2 = WORDS[randomInt(WORDS.length)];
    const w3 = WORDS[randomInt(WORDS.length)];
    const name = `${w1}-${w2}-${w3}`;
    if (!existingNames.has(name)) {
      return name;
    }
  }
  throw new Error(
    "generateSlotName: exhausted 100 attempts — word list may be too small"
  );
}
