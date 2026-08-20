import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runGit } from "./git-client";
import { assertInside, requireAbsolute } from "./paths";
import { WorktreeError } from "./types";

export interface RepositoryContext {
  sourceRoot: string;
  sourceCwd: string;
  baseCommit: string;
}

export async function resolveRepository(cwd: string): Promise<RepositoryContext> {
  requireAbsolute(cwd, "--cwd");
  let sourceCwd: string;
  try {
    sourceCwd = await realpath(cwd);
  } catch {
    throw new WorktreeError("invalid_input", "--cwd must point to an existing directory.");
  }
  const inside = (await runGit(sourceCwd, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") {
    throw new WorktreeError("not_a_repository", "--cwd must be inside a non-bare Git worktree.");
  }
  const sourceRoot = (await runGit(sourceCwd, ["rev-parse", "--show-toplevel"])).trim();
  const baseCommit = (await runGit(sourceRoot, ["rev-parse", "--verify", "HEAD"])).trim();
  const unmerged = await runGit(sourceRoot, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged.trim() !== "") {
    throw new WorktreeError(
      "unsupported_repository_state",
      "Resolve unmerged paths before starting an isolated DSH worktree.",
    );
  }
  return { sourceRoot, sourceCwd, baseCommit };
}

export async function listUntrackedFiles(sourceRoot: string): Promise<string[]> {
  const output = await runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return output.split("\0").filter((path) => path !== "");
}

export async function copyUntrackedFile(
  sourceRoot: string,
  worktreeRoot: string,
  path: string,
): Promise<void> {
  const sourcePath = resolve(sourceRoot, path);
  const targetPath = resolve(worktreeRoot, path);
  assertInside(sourceRoot, sourcePath);
  assertInside(worktreeRoot, targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  assertInside(await realpath(worktreeRoot), await realpath(dirname(targetPath)));
  const information = await lstat(sourcePath);
  if (information.isSymbolicLink()) {
    await symlink(await readlink(sourcePath), targetPath);
    return;
  }
  if (!information.isFile()) {
    throw new WorktreeError(
      "unsupported_file",
      "Only regular files and symbolic links can be mirrored.",
    );
  }
  assertInside(await realpath(sourceRoot), await realpath(sourcePath));
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  await chmod(targetPath, information.mode);
}
