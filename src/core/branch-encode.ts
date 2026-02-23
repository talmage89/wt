/**
 * Encode/decode branch names for safe use in file paths and git ref components.
 */

/**
 * Encode a branch name for safe use in file paths and git ref components.
 * - `/` becomes `--`
 * - Other characters not in [a-zA-Z0-9._-] become percent-encoded (%XX)
 * - Edge cases: leading `.`, consecutive `..` are handled to produce valid file names
 */
export function encodeBranch(name: string): string {
  // First, replace `/` with `--`
  const slashReplaced = name.replace(/\//g, "--");

  // Then percent-encode any remaining invalid chars
  // Valid chars after slash replacement: [a-zA-Z0-9._-]
  let result = "";
  for (const ch of slashReplaced) {
    if (/[a-zA-Z0-9._-]/.test(ch)) {
      result += ch;
    } else {
      const hex = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      result += `%${hex}`;
    }
  }

  // Handle edge case: `..` in output (not valid in file names)
  // Replace each `..` with `.%2E`
  result = result.replace(/\.\./g, ".%2E");

  // Handle edge case: leading `.` (e.g. `.hidden` branches)
  if (result.startsWith(".")) {
    result = "%2E" + result.slice(1);
  }

  return result;
}

/**
 * Decode an encoded branch name back to the original.
 */
export function decodeBranch(encoded: string): string {
  // First, percent-decode
  const percentDecoded = encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });

  // Then, replace `--` back with `/`
  return percentDecoded.replace(/--/g, "/");
}
