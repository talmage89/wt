import { Box } from "ink";
import { useState } from "react";
import type { ContainerPaths } from "../core/container.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { HooksPanel } from "./HooksPanel.js";
import { MainMenu } from "./MainMenu.js";
import { StashPanel } from "./StashPanel.js";
import { TemplatePanel } from "./TemplatePanel.js";
import { WorktreePanel } from "./WorktreePanel.js";

type Screen = "menu" | "worktrees" | "stashes" | "config" | "templates" | "hooks";

interface AppProps {
  containerPaths: ContainerPaths;
}

export function App({ containerPaths }: AppProps) {
  const [screen, setScreen] = useState<Screen>("menu");

  switch (screen) {
    case "menu":
      return <MainMenu onSelect={(s) => setScreen(s as Screen)} />;
    case "worktrees":
      return <WorktreePanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    case "stashes":
      return <StashPanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    case "config":
      return <ConfigPanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    case "templates":
      return <TemplatePanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    case "hooks":
      return <HooksPanel paths={containerPaths} onBack={() => setScreen("menu")} />;
    default:
      return <Box />;
  }
}
