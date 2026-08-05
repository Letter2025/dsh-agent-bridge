import { defineConfig } from "tsdown";

const outputExtensions = () => ({ js: ".js", dts: ".d.ts" });

export default defineConfig([
  {
    entry: "packages/core/src/index.ts",
    outDir: "packages/core/dist",
    outExtensions: outputExtensions,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: false,
    clean: true,
  },
  {
    entry: "packages/mcp-server/src/index.ts",
    outDir: "packages/mcp-server/dist",
    outExtensions: outputExtensions,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: false,
    clean: true,
  },
  {
    entry: "skill/qoder-agent/scripts/run_qoder.ts",
    outDir: "dist/skill/qoder-agent/scripts",
    outExtensions: outputExtensions,
    format: ["esm"],
    dts: false,
    sourcemap: true,
    treeshake: false,
    clean: true,
  },
]);
