const CLAUDE_CODE_HOOK = {
  hooks: {
    PreToolUse: [
      {
        matcher: ".*",
        hooks: [
          {
            type: "command",
            command: "wt pin 2>/dev/null || true",
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: ".*",
        hooks: [
          {
            type: "command",
            command: "wt unpin 2>/dev/null || true",
          },
        ],
      },
    ],
  },
};

const SUPPORTED_INTEGRATIONS = ["claude-code"] as const;
type Integration = (typeof SUPPORTED_INTEGRATIONS)[number];

export function runHooksShow(integration: string): void {
  if (!SUPPORTED_INTEGRATIONS.includes(integration as Integration)) {
    process.stderr.write(
      `wt: Unknown integration '${integration}'. Supported: ${SUPPORTED_INTEGRATIONS.join(", ")}\n`
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(CLAUDE_CODE_HOOK, null, 2) + "\n");
}
