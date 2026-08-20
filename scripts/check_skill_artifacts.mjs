import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsdown";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-agent-skill-build-"));
const artifacts = [
  {
    name: "dsh_web",
    entry: "packages/cli/src/dsh-web.ts",
    committed: "skill/dsh-agent/scripts/dsh_web.mjs",
  },
  {
    name: "run_dsh",
    entry: "packages/cli/src/run-dsh.ts",
    committed: "skill/dsh-agent/scripts/run_dsh.mjs",
  },
  {
    name: "dsh_worktree",
    entry: "packages/cli/src/dsh-worktree.ts",
    committed: "skill/dsh-agent/scripts/dsh_worktree.mjs",
  },
];

try {
  for (const artifact of artifacts) {
    const outDir = join(temporaryRoot, artifact.name);
    await build({
      config: false,
      entry: { [artifact.name]: artifact.entry },
      outDir,
      outExtensions: () => ({ js: ".mjs" }),
      format: ["esm"],
      dts: false,
      sourcemap: false,
      treeshake: false,
      clean: true,
      report: false,
      logLevel: "silent",
      deps: {
        alwaysBundle: ["@dsh-agent-bridge/core"],
      },
    });

    const generated = await readFile(join(outDir, `${artifact.name}.mjs`));
    const committed = await readFile(resolve(root, artifact.committed));
    if (!generated.equals(committed)) {
      throw new Error(
        `${artifact.committed} is stale. Run pnpm skill:build and commit the regenerated artifact.`,
      );
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
