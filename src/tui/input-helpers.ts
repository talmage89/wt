/**
 * Shared text-editing helpers for TUI input fields.
 *
 * These mirror classic macOS / emacs keybindings:
 *   Option+Backspace / Ctrl+W  →  deleteWordBackward
 *   Cmd+Backspace / Ctrl+U     →  deleteToLineStart
 *
 * Word boundaries include `/`, `-`, `_`, and `.` so that branch names
 * like "feature/my-branch-name" can be erased component-by-component.
 */

const WORD_DELIMITERS = new Set(["/", "-", "_", "."]);

/**
 * Delete one "word" from the end of `s`.
 *
 * Skips trailing whitespace, then trailing delimiter chars, then the preceding
 * run of non-delimiter/non-space chars.
 */
export function deleteWordBackward(s: string): string {
  if (s.length === 0) return s;
  let i = s.length - 1;

  // 1. Skip trailing whitespace
  while (i >= 0 && s[i] === " ") i--;

  // 2. Skip trailing delimiter chars (/, -, _, .)
  const atDelimiter = i >= 0 && WORD_DELIMITERS.has(s[i]!);
  if (atDelimiter) {
    while (i >= 0 && WORD_DELIMITERS.has(s[i]!)) i--;
  } else {
    // 3. Skip word chars (non-space, non-delimiter)
    while (i >= 0 && s[i] !== " " && !WORD_DELIMITERS.has(s[i]!)) i--;
  }

  return s.slice(0, i + 1);
}

/** Delete everything (clear to start of line). */
export function deleteToLineStart(): string {
  return "";
}

/**
 * Handle text-editing key combos on a setter function.
 *
 * Returns `true` if the combo was consumed, `false` otherwise.
 */
export function handleTextEditingKeys(
  input: string,
  key: { ctrl: boolean; meta: boolean; backspace: boolean; delete: boolean },
  setter: React.Dispatch<React.SetStateAction<string>>,
): boolean {
  // Option+Backspace → delete word backward
  if (key.meta && (key.backspace || key.delete)) {
    setter((s) => deleteWordBackward(s));
    return true;
  }

  // Ctrl+W → delete word backward
  if (key.ctrl && input === "w") {
    setter((s) => deleteWordBackward(s));
    return true;
  }

  // Ctrl+U → delete to start of line
  if (key.ctrl && input === "u") {
    setter(deleteToLineStart);
    return true;
  }

  return false;
}
