import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const coreSpecifier = 'from "@dsh-agent-bridge/core"';
const packageOutputs = [
  "packages/cli/dist/dsh-web.js",
  "packages/cli/dist/run-dsh.js",
  "packages/cli/dist/dsh-worktree.js",
];
const skillOutputs = [
  "skill/dsh-agent/scripts/dsh_web.mjs",
  "skill/dsh-agent/scripts/run_dsh.mjs",
  "skill/dsh-agent/scripts/dsh_worktree.mjs",
];

for (const relativePath of packageOutputs) {
  const path = resolve(root, relativePath);
  const source = await readFile(path, "utf8");
  if (!source.includes(coreSpecifier)) {
    throw new Error(`${relativePath} must import core through its package boundary.`);
  }
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o111) === 0) {
    throw new Error(`${relativePath} must be executable.`);
  }
}

const generatedFiles = (await readdir(resolve(root, "skill/dsh-agent/scripts")))
  .filter((name) => name.endsWith(".mjs"))
  .sort();
const expectedFiles = skillOutputs.map((path) => path.split("/").at(-1)).sort();
if (JSON.stringify(generatedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error("Skill build must contain exactly the two standalone executable artifacts.");
}

for (const relativePath of skillOutputs) {
  const path = resolve(root, relativePath);
  const source = await readFile(path, "utf8");
  if (source.includes("@dsh-agent-bridge/core") || /from\s+["']\.\//.test(source)) {
    throw new Error(`${relativePath} must inline core and remain independently executable.`);
  }
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o111) === 0) {
    throw new Error(`${relativePath} must be executable.`);
  }
}
