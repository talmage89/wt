export type ShellType = "bash" | "zsh" | "fish";

// Shell function for bash — wraps the wt binary to handle directory navigation.
// After commands that produce a nav file (/tmp/wt-nav-$$), cd to the target dir
// and run the post-checkout hook if present.
const BASH_SCRIPT = `wt() {
  local wt_bin
  wt_bin="$(command -v wt)" || { echo "wt: binary not found" >&2; return 1; }

  "$wt_bin" "$@"
  local exit_code=$?

  local nav_file="/tmp/wt-nav-$$"
  if [ -f "$nav_file" ]; then
    local target_dir
    target_dir="$(cat "$nav_file")"
    rm -f "$nav_file"
    if [ -d "$target_dir" ]; then
      cd "$target_dir" || return 1
    fi
    # Execute post-checkout hook if it exists
    local wt_dir
    wt_dir="$(cd "$target_dir" && cd .. && pwd)/.wt"
    if [ -x "$wt_dir/hooks/post-checkout" ]; then
      "$wt_dir/hooks/post-checkout" "$target_dir" "$(cd "$target_dir" && git symbolic-ref --short HEAD 2>/dev/null)"
    fi
  fi

  return $exit_code
}`;

// zsh is compatible with the bash version for this use case
const ZSH_SCRIPT = BASH_SCRIPT;

const FISH_SCRIPT = `function wt
    set -l wt_bin (command -v wt)
    or begin; echo "wt: binary not found" >&2; return 1; end

    $wt_bin $argv
    set -l exit_code $status

    set -l nav_file "/tmp/wt-nav-$fish_pid"
    if test -f $nav_file
        set -l target_dir (cat $nav_file)
        rm -f $nav_file
        if test -d $target_dir
            cd $target_dir
        end
        set -l wt_dir (cd $target_dir/.. && pwd)"/.wt"
        if test -x $wt_dir/hooks/post-checkout
            $wt_dir/hooks/post-checkout $target_dir (cd $target_dir && git symbolic-ref --short HEAD 2>/dev/null)
        end
    end

    return $exit_code
end`;

/**
 * Return the shell integration function code for the given shell.
 * The output should be eval'd in the user's shell config.
 */
export function runShellInit(shell: ShellType): string {
  switch (shell) {
    case "bash":
      return BASH_SCRIPT;
    case "zsh":
      return ZSH_SCRIPT;
    case "fish":
      return FISH_SCRIPT;
    default: {
      const _exhaustive: never = shell;
      throw new Error(`Unknown shell: ${_exhaustive}`);
    }
  }
}
