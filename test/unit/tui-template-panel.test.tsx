import { render } from "ink-testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/config.js", () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));
vi.mock("../../src/core/state.js", () => ({
  readState: vi.fn(),
}));
vi.mock("../../src/core/templates.js", () => ({
  generateAllTemplates: vi.fn(),
}));

import { readConfig } from "../../src/core/config.js";
import { TemplatePanel } from "../../src/tui/TemplatePanel.js";

const mockPaths = {
  container: "/fake/container",
  wtDir: "/fake/container/.wt",
  repoDir: "/fake/container/.wt/repo",
};

const defaultConfig = {
  slot_count: 5,
  archive_after_days: 7,
  fetch_cooldown_minutes: 10,
  shared: { directories: [], files: [] },
  templates: [],
};

async function waitUntil(fn: () => void, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      fn();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  fn(); // final attempt — let it throw
}

describe("TemplatePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state on first render", () => {
    vi.mocked(readConfig).mockResolvedValue({ ...defaultConfig });
    const { lastFrame } = render(<TemplatePanel paths={mockPaths} onBack={() => {}} />);
    expect(lastFrame()).toContain("Edit Templates");
    expect(lastFrame()).toContain("Loading...");
  });

  it("shows create option when no templates configured", async () => {
    vi.mocked(readConfig).mockResolvedValue({ ...defaultConfig });
    const { lastFrame } = render(<TemplatePanel paths={mockPaths} onBack={() => {}} />);
    await waitUntil(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Create template");
      expect(frame).not.toContain("Loading...");
    });
  });

  it("displays configured templates with source and target", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      ...defaultConfig,
      templates: [
        {
          source: "templates/.env.development",
          target: ".env.development",
        },
        {
          source: "templates/docker-compose.override.yml",
          target: "docker-compose.override.yml",
        },
      ],
    });
    const { lastFrame } = render(<TemplatePanel paths={mockPaths} onBack={() => {}} />);
    await waitUntil(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("templates/.env.development");
      expect(frame).toContain("templates/docker-compose.override.yml");
    });
  });

  it("shows keybinding hints in list mode", async () => {
    vi.mocked(readConfig).mockResolvedValue({ ...defaultConfig });
    const { lastFrame } = render(<TemplatePanel paths={mockPaths} onBack={() => {}} />);
    await waitUntil(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("Enter: edit");
      expect(frame).toContain("Esc: back");
      expect(frame).toContain("q: quit");
    });
  });

  it("shows panel title", async () => {
    vi.mocked(readConfig).mockResolvedValue({ ...defaultConfig });
    const { lastFrame } = render(<TemplatePanel paths={mockPaths} onBack={() => {}} />);
    await waitUntil(() => {
      expect(lastFrame()).toContain("Edit Templates");
    });
  });
});
