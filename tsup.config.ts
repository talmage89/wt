import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  sourcemap: true,
  dts: true,
  clean: true,
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "react";
  },
});
