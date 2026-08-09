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
    entry: {
      "run-qoder": "packages/cli/src/run-qoder.ts",
      "qoder-worktree": "packages/cli/src/qoder-worktree.ts",
    },
    outDir: "packages/cli/dist",
    outExtensions: outputExtensions,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: false,
    clean: true,
    deps: {
      neverBundle: ["@qoder-agent-bridge/core"],
    },
  },
  {
    entry: {
      run_qoder: "packages/cli/src/run-qoder.ts",
    },
    outDir: "skill/qoder-agent/scripts",
    outExtensions: () => ({ js: ".mjs" }),
    format: ["esm"],
    dts: false,
    sourcemap: false,
    treeshake: false,
    clean: false,
    deps: {
      alwaysBundle: ["@qoder-agent-bridge/core"],
    },
  },
  {
    entry: {
      qoder_worktree: "packages/cli/src/qoder-worktree.ts",
    },
    outDir: "skill/qoder-agent/scripts",
    outExtensions: () => ({ js: ".mjs" }),
    format: ["esm"],
    dts: false,
    sourcemap: false,
    treeshake: false,
    clean: false,
    deps: {
      alwaysBundle: ["@qoder-agent-bridge/core"],
    },
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
]);
