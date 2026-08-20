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
      "dsh-web": "packages/cli/src/dsh-web.ts",
      "run-dsh": "packages/cli/src/run-dsh.ts",
      "dsh-worktree": "packages/cli/src/dsh-worktree.ts",
    },
    outDir: "packages/cli/dist",
    outExtensions: outputExtensions,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: false,
    clean: true,
    deps: {
      neverBundle: ["@dsh-agent-bridge/core"],
    },
  },
  {
    entry: {
      dsh_web: "packages/cli/src/dsh-web.ts",
    },
    outDir: "skill/dsh-agent/scripts",
    outExtensions: () => ({ js: ".mjs" }),
    format: ["esm"],
    dts: false,
    sourcemap: false,
    treeshake: false,
    clean: false,
    deps: {
      alwaysBundle: ["@dsh-agent-bridge/core"],
    },
  },
  {
    entry: {
      run_dsh: "packages/cli/src/run-dsh.ts",
    },
    outDir: "skill/dsh-agent/scripts",
    outExtensions: () => ({ js: ".mjs" }),
    format: ["esm"],
    dts: false,
    sourcemap: false,
    treeshake: false,
    clean: false,
    deps: {
      alwaysBundle: ["@dsh-agent-bridge/core"],
    },
  },
  {
    entry: {
      dsh_worktree: "packages/cli/src/dsh-worktree.ts",
    },
    outDir: "skill/dsh-agent/scripts",
    outExtensions: () => ({ js: ".mjs" }),
    format: ["esm"],
    dts: false,
    sourcemap: false,
    treeshake: false,
    clean: false,
    deps: {
      alwaysBundle: ["@dsh-agent-bridge/core"],
    },
  },
]);
