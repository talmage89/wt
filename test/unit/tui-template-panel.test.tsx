import React from "react";
import { render } from "ink-testing-library";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/core/config.js", () => ({
  readConfig: vi.fn(),
}));
vi.mock("../../src/core/state.js", () => ({
  readState: vi.fn(),
}));
vi.mock("../../src/core/templates.js", () => ({
  generateAllTemplates: vi.fn(),
}));

import { TemplatePanel } from "../../src/tui/TemplatePanel.js";
import { readConfig } from "../../src/core/config.js";

const mockPaths = {
  container: "/fake/container",
  wtDir: "/fake/container/.wt",
  repoDir: "/fake/container/.wt/repo",
};

function waitForEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("TemplatePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state on first render", () => {
    vi.mocked(readConfig).mockResolvedValue({
      slot_count: 5,
      archive_after_days: 7,
      shared: { directories: [] },
      templates: [],
    });
    const { lastFrame } = render(
      <TemplatePanel paths={mockPaths} onBack={() => {}} />
    );
    expect(lastFrame()).toContain("Edit Templates");
    expect(lastFrame()).toContain("Loading...");
  });

  it("shows empty state when no templates configured", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      slot_count: 5,
      archive_after_days: 7,
      shared: { directories: [] },
      templates: [],
    });
    const { lastFrame } = render(
      <TemplatePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Edit Templates");
    expect(frame).toContain("No templates configured");
    expect(frame).not.toContain("Loading...");
  });

  it("displays configured templates with source and target", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      slot_count: 5,
      archive_after_days: 7,
      shared: { directories: [] },
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
    const { lastFrame } = render(
      <TemplatePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("templates/.env.development");
    expect(frame).toContain(".env.development");
    expect(frame).toContain("templates/docker-compose.override.yml");
    expect(frame).toContain("docker-compose.override.yml");
  });

  it("shows keybinding hints in list mode", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      slot_count: 5,
      archive_after_days: 7,
      shared: { directories: [] },
      templates: [],
    });
    const { lastFrame } = render(
      <TemplatePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Enter: edit");
    expect(frame).toContain("Esc: back");
    expect(frame).toContain("q: quit");
  });

  it("shows panel title", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      slot_count: 5,
      archive_after_days: 7,
      shared: { directories: [] },
      templates: [],
    });
    const { lastFrame } = render(
      <TemplatePanel paths={mockPaths} onBack={() => {}} />
    );
    await waitForEffects();
    expect(lastFrame()).toContain("Edit Templates");
  });
});
