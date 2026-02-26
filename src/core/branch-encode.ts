/**
 * Encode/decode branch names for safe use in file paths and git ref components.
 */

/**
 * Encode a branch name for safe use in file paths and git ref components.
 * - Literal `--` becomes `%2D%2D` (to prevent collision with the `/` separator)
 * - `/` becomes `--`
 * - Other characters not in [a-zA-Z0-9._-] become percent-encoded (%XX)
 * - Edge cases: leading `.`, consecutive `..` are handled to produce valid file names
 *
 * The encoding is injective: no two distinct branch names produce the same encoded form.
 * (BUG-034: the prior scheme treated "--" in branch names identically to "/", causing
 * `feature--test` and `feature/test` to collide on `feature--test`.)
 */
export function encodeBranch(name: string): string {
  // Single-pass encoding. Order within each character position is:
  //   1. "--" (double-dash) → "%2D%2D"  (escape literal "--" BEFORE "/" → "--" step)
  //   2. "/"               → "--"       (the path-separator replacement)
  //   3. [a-zA-Z0-9._-]   → unchanged
  //   4. anything else     → %XX
  let result = "";
  let i = 0;
  while (i < name.length) {
    const ch = name[i];

    // BUG-034: Escape literal "--" so it cannot collide with the "/" → "--" separator.
    if (ch === "-" && name[i + 1] === "-") {
      result += "%2D%2D";
      i += 2;
      continue;
    }

    // Replace "/" with "--" (unambiguous since literal "--" is escaped above).
    if (ch === "/") {
      result += "--";
      i++;
      continue;
    }

    // Valid chars pass through.
    if (/[a-zA-Z0-9._-]/.test(ch)) {
      result += ch;
      i++;
      continue;
    }

    // Percent-encode any remaining invalid chars.
    const hex = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    result += `%${hex}`;
    i++;
  }

  // Handle edge case: `..` in output (not valid in file names).
  result = result.replace(/\.\./g, ".%2E");

  // Handle edge case: leading `.` (e.g. `.hidden` branches).
  if (result.startsWith(".")) {
    result = "%2E" + result.slice(1);
  }

  return result;
}

/**
 * Decode an encoded branch name back to the original.
 *
 * Decode is the exact reverse of encode:
 *   1. Replace "--" back with "/"   (unambiguous: only "/" was encoded as "--")
 *   2. Percent-decode               (restores "%2D%2D" → "--", "%20" → " ", etc.)
 */
export function decodeBranch(encoded: string): string {
  // BUG-034: Must decode in reverse order of encoding.
  // If we percent-decode first, "%2D%2D" becomes "--" and then "--" → "/" would
  // incorrectly turn literal double-dashes into slashes.
  const slashRestored = encoded.replace(/--/g, "/");
  return slashRestored.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}
