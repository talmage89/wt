import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all I/O dependencies before importing the component
vi.mock("../../src/core/state.js", () => ({
  readState: vi.fn(),
  writeState: vi.fn(),
}));
vi.mock("../../src/core/reconcile.js", () => ({
  reconcile: vi.fn(),
}));
vi.mock("../../src/core/stash.js", () => ({
  getStash: vi.fn(),
  showStash: vi.fn(),
}));
vi.mock("../../src/core/git.js", () => ({
  status: vi.fn(),
  listLocalBranches: vi.fn(),
  listRemoteBranches: vi.fn(),
}));
vi.mock("../../src/commands/checkout.js", () => ({
  runCheckout: vi.fn(),
}));

import { WorktreePanel } from "../../src/tui/WorktreePanel.js";
import { readState } from "../../src/core/state.js";
import { reconcile } from "../../src/core/reconcile.js";
import { getStash } from "../../src/core/stash.js";
import * as gitMod from "../../src/core/git.js";

const mockPaths = {
  container: "/fake/container",
  wtDir: "/fake/container/.wt",
  repoDir: "/fake/container/.wt/repo",
};

const emptyState = { slots: {}, branch_history: [] };

/** Wait for React effects (useEffect + async state updates) to settle. */
function waitForEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("WorktreePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue(emptyState);
    vi.mocked(reconcile).mockImplementation(async (_, __, state) => state);
    vi.mocked(getStash).mockResolvedValue(null);
    vi.mocked(gitMod.status).mockResolvedValue("");
  });

  it("shows loading state on first render", () => {
    const { lastFrame } = render(
      <WorktreePanel paths={mockPaths} onBack={() => {}} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Manage Worktrees");
    expect(frame).toContain("Loading...");
  });

  it("shows empty state after loading completes with no data", async () => {
    const { lastFrame } = render(
      <WorktreePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Manage Worktrees");
    // No longer in loading state, shows worktree list (empty)
    expect(frame).not.toContain("Loading...");
  });

  it("displays active branch entries with slot names", async () => {
    const stateWithSlot = {
      slots: {
        "crimson-maple-river": {
          branch: "main",
          last_used_at: "2026-02-22T12:00:00.000Z",
          pinned: false,
        },
      },
      branch_history: [
        { branch: "main", last_checkout_at: "2026-02-22T12:00:00.000Z" },
      ],
    };
    vi.mocked(readState).mockResolvedValue(stateWithSlot);
    vi.mocked(reconcile).mockImplementation(async (_, __, state) => state);

    const { lastFrame } = render(
      <WorktreePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("main");
    expect(frame).toContain("crimson-maple-river");
  });

  it("shows pinned indicator for pinned branches", async () => {
    const stateWithPinned = {
      slots: {
        "gentle-autumn-spark": {
          branch: "feature/auth",
          last_used_at: "2026-02-22T12:00:00.000Z",
          pinned: true,
        },
      },
      branch_history: [
        { branch: "feature/auth", last_checkout_at: "2026-02-22T12:00:00.000Z" },
      ],
    };
    vi.mocked(readState).mockResolvedValue(stateWithPinned);
    vi.mocked(reconcile).mockImplementation(async (_, __, state) => state);

    const { lastFrame } = render(
      <WorktreePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("feature/auth");
    // Pin indicator (emoji) should appear
    expect(frame).toContain("📌");
  });

  it("shows [stash] marker for inactive branches with active stash", async () => {
    const stateWithHistory = {
      slots: {},
      branch_history: [
        { branch: "fix/old-bug", last_checkout_at: "2026-02-15T10:00:00.000Z" },
      ],
    };
    vi.mocked(readState).mockResolvedValue(stateWithHistory);
    vi.mocked(reconcile).mockImplementation(async (_, __, state) => state);
    vi.mocked(getStash).mockResolvedValue({
      branch: "fix/old-bug",
      commit: "abc123",
      stash_ref: "def456",
      created_at: "2026-02-15T10:00:00.000Z",
      last_used_at: "2026-02-15T10:00:00.000Z",
      status: "active" as const,
    });

    const { lastFrame } = render(
      <WorktreePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fix/old-bug");
    expect(frame).toContain("[stash]");
  });
});
