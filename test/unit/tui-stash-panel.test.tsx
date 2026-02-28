import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/stash.js", () => ({
  listStashes: vi.fn(),
  dropStash: vi.fn(),
  showStash: vi.fn(),
  restoreStash: vi.fn(),
}));
vi.mock("../../src/core/state.js", () => ({
  readState: vi.fn(),
}));
vi.mock("../../src/commands/checkout.js", () => ({
  runCheckout: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ size: 2048 }),
}));

import { listStashes } from "../../src/core/stash.js";
import { StashPanel } from "../../src/tui/StashPanel.js";

const mockPaths = {
  container: "/fake/container",
  wtDir: "/fake/container/.wt",
  repoDir: "/fake/container/.wt/repo",
};

function waitForEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("StashPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state on first render", () => {
    vi.mocked(listStashes).mockResolvedValue([]);
    const { lastFrame } = render(<StashPanel paths={mockPaths} onBack={() => {}} />);
    expect(lastFrame()).toContain("Manage Stashes");
    expect(lastFrame()).toContain("Loading...");
  });

  it("shows empty state when no stashes exist", async () => {
    vi.mocked(listStashes).mockResolvedValue([]);
    const { lastFrame } = render(<StashPanel paths={mockPaths} onBack={() => {}} />);
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Manage Stashes");
    expect(frame).toContain("No stashes");
    expect(frame).not.toContain("Loading...");
  });

  it("displays active stashes", async () => {
    vi.mocked(listStashes).mockResolvedValue([
      {
        branch: "feature/auth",
        commit: "abc1234",
        stash_ref: "def5678",
        created_at: "2026-02-22T10:00:00.000Z",
        last_used_at: "2026-02-22T10:00:00.000Z",
        status: "active",
      },
    ]);
    const { lastFrame } = render(<StashPanel paths={mockPaths} onBack={() => {}} />);
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("feature/auth");
    expect(frame).toContain("Active Stashes");
    expect(frame).toContain("abc1234");
  });

  it("displays archived stashes with size", async () => {
    vi.mocked(listStashes).mockResolvedValue([
      {
        branch: "old/feature",
        commit: "abc1234",
        stash_ref: "def5678",
        created_at: "2026-02-01T10:00:00.000Z",
        last_used_at: "2026-02-01T10:00:00.000Z",
        status: "archived",
        archived_at: "2026-02-08T10:00:00.000Z",
        archive_path: "/fake/archive.patch.zst",
      },
    ]);
    const { lastFrame } = render(<StashPanel paths={mockPaths} onBack={() => {}} />);
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("old/feature");
    expect(frame).toContain("Archived Stashes");
    expect(frame).toContain("[archived]");
    // Archive size (mocked at 2048 bytes = 2 KB)
    expect(frame).toContain("2 KB");
  });

  it("shows both active and archived groups when both exist", async () => {
    vi.mocked(listStashes).mockResolvedValue([
      {
        branch: "active/branch",
        commit: "aaa1111",
        stash_ref: "bbb2222",
        created_at: "2026-02-22T10:00:00.000Z",
        last_used_at: "2026-02-22T10:00:00.000Z",
        status: "active",
      },
      {
        branch: "archived/branch",
        commit: "ccc3333",
        stash_ref: "ddd4444",
        created_at: "2026-02-01T10:00:00.000Z",
        last_used_at: "2026-02-01T10:00:00.000Z",
        status: "archived",
        archived_at: "2026-02-08T10:00:00.000Z",
        archive_path: "/fake/archive.patch.zst",
      },
    ]);
    const { lastFrame } = render(<StashPanel paths={mockPaths} onBack={() => {}} />);
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Active Stashes");
    expect(frame).toContain("Archived Stashes");
    expect(frame).toContain("active/branch");
    expect(frame).toContain("archived/branch");
  });

  it("shows keybinding hints in list mode", async () => {
    vi.mocked(listStashes).mockResolvedValue([]);
    const { lastFrame } = render(<StashPanel paths={mockPaths} onBack={() => {}} />);
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Esc");
    expect(frame).toContain("quit");
  });
});
