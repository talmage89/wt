import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { MainMenu } from "../../src/tui/MainMenu.js";

describe("MainMenu", () => {
  it("renders all four menu items", () => {
    const { lastFrame } = render(<MainMenu onSelect={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Manage Worktrees");
    expect(frame).toContain("Manage Stashes");
    expect(frame).toContain("Edit Configuration");
    expect(frame).toContain("Edit Templates");
  });

  it("renders the app title", () => {
    const { lastFrame } = render(<MainMenu onSelect={() => {}} />);
    expect(lastFrame()).toContain("wt — Git Worktree Control Plane");
  });

  it("renders navigation hint", () => {
    const { lastFrame } = render(<MainMenu onSelect={() => {}} />);
    expect(lastFrame()).toContain("q quit");
  });
});
