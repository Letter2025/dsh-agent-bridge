#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKTREE_SESSION_VERSION = 1;
export const SESSION_PREFIX = "qoder-agent-worktree-";
export const PATCH_FILE_NAME = "qoder-only.patch";
export const STATE_FILE_NAME = "session.json";
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

class WorktreeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

/**
 * @typedef {Object} WorktreeSession
 * @property {number} version
 * @property {"prepared" | "review_ready" | "applied"} phase
 * @property {string} sessionRoot
 * @property {string} statePath
 * @property {string} sourceRoot
 * @property {string} sourceCwd
 * @property {string} worktreeRoot
 * @property {string} worktreeCwd
 * @property {string} baseCommit
 * @property {string} baselineTree
 * @property {string} baselinePatchPath
 * @property {string} reviewPatchPath
 * @property {string | null} retryOf
 */

/**
 * @param {string[]} argv
 * @returns {{command: "prepare" | "inspect" | "diff" | "apply" | "dispose", cwd?: string, state?: string, retryOf?: string, discard: boolean}}
 */
export function parseArgs(argv) {
  const command = argv[0];
  if (!["prepare", "inspect", "diff", "apply", "dispose"].includes(command ?? "")) {
    throw new WorktreeError("invalid_input", "Use prepare, inspect, diff, apply, or dispose.");
  }

  /** @type {{cwd?: string, state?: string, retryOf?: string, discard: boolean}} */
  const values = { discard: false };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--discard") {
      if (values.discard) {
        throw new WorktreeError("invalid_input", "--discard was provided more than once.");
      }
      values.discard = true;
      continue;
    }
    if (option !== "--cwd" && option !== "--state" && option !== "--retry-of") {
      throw new WorktreeError("invalid_input", "Unsupported worktree coordinator argument.");
    }
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "") {
      throw new WorktreeError(
        "invalid_input",
        "Worktree coordinator argument is missing its value.",
      );
    }
    if (option === "--cwd") {
      if (values.cwd !== undefined) {
        throw new WorktreeError("invalid_input", "--cwd was provided more than once.");
      }
      values.cwd = value;
    } else if (option === "--state") {
      if (values.state !== undefined) {
        throw new WorktreeError("invalid_input", "--state was provided more than once.");
      }
      values.state = value;
    } else {
      if (values.retryOf !== undefined) {
        throw new WorktreeError("invalid_input", "--retry-of was provided more than once.");
      }
      values.retryOf = value;
    }
    index += 1;
  }

  if (command === "prepare") {
    if (values.cwd === undefined || values.state !== undefined || values.discard) {
      throw new WorktreeError(
        "invalid_input",
        "prepare requires --cwd <absolute-path> and optionally --retry-of <state-path>.",
      );
    }
  } else if (
    values.state === undefined ||
    values.cwd !== undefined ||
    values.retryOf !== undefined ||
    (command !== "dispose" && values.discard)
  ) {
    throw new WorktreeError("invalid_input", `${command} requires only --state <absolute-path>.`);
  }

  return {
    command: /** @type {"prepare" | "inspect" | "diff" | "apply" | "dispose"} */ (command),
    ...values,
  };
}

/**
 * @param {string} value
 * @param {string} name
 */
function requireAbsolute(value, name) {
  if (!isAbsolute(value)) {
    throw new WorktreeError("invalid_input", `${name} must be an absolute path.`);
  }
}

/**
 * @param {string} root
 * @param {string} target
 */
function assertInside(root, target) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new WorktreeError("invalid_input", "Path escapes its expected project root.");
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{allowExitCodes?: number[], maxBytes?: number}} [options]
 * @returns {Promise<string>}
 */
async function runGit(cwd, args, options = {}) {
  const allowed = new Set(options.allowExitCodes ?? [0]);
  const maxBytes = options.maxBytes ?? MAX_GIT_OUTPUT_BYTES;
  return await new Promise((resolveOutput, rejectOutput) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    let size = 0;
    let overflowed = false;

    /** @param {Buffer[]} chunks @param {Buffer} chunk */
    const collect = (chunks, chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => collect(stderr, Buffer.from(chunk)));
    child.on("error", () => {
      rejectOutput(new WorktreeError("git_unavailable", "Git could not be started."));
    });
    child.on("close", (code) => {
      if (overflowed) {
        rejectOutput(new WorktreeError("output_limit", "Git output exceeded the 64 MiB limit."));
        return;
      }
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      if (!allowed.has(code ?? 1)) {
        rejectOutput(
          new WorktreeError(
            "git_failed",
            diagnostic === "" ? "Git command failed." : `Git command failed: ${diagnostic}`,
          ),
        );
        return;
      }
      resolveOutput(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

/**
 * @param {string} cwd
 * @returns {Promise<{sourceRoot: string, sourceCwd: string, baseCommit: string}>}
 */
async function resolveRepository(cwd) {
  requireAbsolute(cwd, "--cwd");
  let sourceCwd;
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
      "Resolve unmerged paths before starting an isolated Qoder worktree.",
    );
  }
  return { sourceRoot, sourceCwd, baseCommit };
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<string[]>}
 */
async function listUntrackedFiles(sourceRoot) {
  const output = await runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return output.split("\0").filter((path) => path !== "");
}

/**
 * @param {string} sourceRoot
 * @param {string} worktreeRoot
 * @param {string} path
 */
async function copyUntrackedFile(sourceRoot, worktreeRoot, path) {
  const sourcePath = resolve(sourceRoot, path);
  const targetPath = resolve(worktreeRoot, path);
  assertInside(sourceRoot, sourcePath);
  assertInside(worktreeRoot, targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
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
  await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  await chmod(targetPath, information.mode);
}

/**
 * @param {WorktreeSession} session
 */
async function writeSession(session) {
  await writeFile(session.statePath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

/**
 * @param {string} statePath
 * @returns {Promise<WorktreeSession>}
 */
async function readSession(statePath) {
  requireAbsolute(statePath, "--state");
  let resolvedState;
  try {
    resolvedState = await realpath(statePath);
  } catch {
    throw new WorktreeError("invalid_input", "--state must point to an existing session file.");
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolvedState, "utf8"));
  } catch {
    throw new WorktreeError("invalid_input", "--state is not a readable Qoder worktree session.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WorktreeError("invalid_input", "--state is not a valid Qoder worktree session.");
  }
  const session = /** @type {Partial<WorktreeSession>} */ (parsed);
  const requiredStrings = [
    session.sessionRoot,
    session.sourceRoot,
    session.sourceCwd,
    session.worktreeRoot,
    session.worktreeCwd,
    session.baseCommit,
    session.baselineTree,
    session.baselinePatchPath,
    session.reviewPatchPath,
  ];
  if (
    session.version !== WORKTREE_SESSION_VERSION ||
    !["prepared", "review_ready", "applied"].includes(session.phase ?? "") ||
    requiredStrings.some((value) => typeof value !== "string") ||
    (session.retryOf !== undefined &&
      session.retryOf !== null &&
      typeof session.retryOf !== "string")
  ) {
    throw new WorktreeError("invalid_input", "--state is not a valid Qoder worktree session.");
  }
  if (typeof session.retryOf === "string") {
    requireAbsolute(session.retryOf, "retryOf");
  }
  const storedSessionRoot = resolve(/** @type {string} */ (session.sessionRoot));
  let sessionRoot;
  try {
    sessionRoot = await realpath(storedSessionRoot);
  } catch {
    throw new WorktreeError(
      "invalid_input",
      "--state is outside an existing Qoder worktree session.",
    );
  }
  /** @param {string} path */
  const normalizeSessionPath = (path) => {
    assertInside(storedSessionRoot, path);
    return resolve(sessionRoot, relative(storedSessionRoot, path));
  };
  const worktreeRoot = normalizeSessionPath(/** @type {string} */ (session.worktreeRoot));
  const worktreeCwd = normalizeSessionPath(/** @type {string} */ (session.worktreeCwd));
  const baselinePatchPath = normalizeSessionPath(/** @type {string} */ (session.baselinePatchPath));
  const reviewPatchPath = normalizeSessionPath(/** @type {string} */ (session.reviewPatchPath));
  if (!basename(sessionRoot).startsWith(SESSION_PREFIX)) {
    throw new WorktreeError("invalid_input", "--state is outside a Qoder worktree session.");
  }
  assertInside(sessionRoot, resolvedState);
  assertInside(sessionRoot, worktreeRoot);
  assertInside(sessionRoot, baselinePatchPath);
  assertInside(sessionRoot, reviewPatchPath);
  assertInside(worktreeRoot, worktreeCwd);
  return /** @type {WorktreeSession} */ ({
    ...session,
    retryOf: session.retryOf ?? null,
    statePath: resolvedState,
  });
}

/**
 * @param {string} statePath
 * @returns {Promise<boolean>}
 */
async function sessionFileExists(statePath) {
  try {
    await lstat(statePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Read the predecessor sessions from newest to oldest, validating that every
 * session belongs to the source repository. A missing predecessor has
 * already been cleaned and is therefore not an error.
 *
 * @param {string | null} retryOf
 * @param {string} sourceRoot
 * @returns {Promise<WorktreeSession[]>}
 */
async function readRetryChain(retryOf, sourceRoot) {
  /** @type {WorktreeSession[]} */
  const sessions = [];
  const seen = new Set();
  let statePath = retryOf;
  while (statePath !== null) {
    requireAbsolute(statePath, "retryOf");
    if (seen.has(statePath)) {
      throw new WorktreeError("invalid_state", "The retry session chain contains a cycle.");
    }
    seen.add(statePath);
    if (!(await sessionFileExists(statePath))) {
      break;
    }
    const session = await readSession(statePath);
    if (resolve(session.sourceRoot) !== resolve(sourceRoot)) {
      throw new WorktreeError(
        "invalid_state",
        "The retry session chain contains a session from another source worktree.",
      );
    }
    sessions.push(session);
    statePath = session.retryOf;
  }
  return sessions;
}

/**
 * @param {WorktreeSession} session
 * @param {boolean} discard
 */
async function disposeSession(session, discard) {
  if (session.phase !== "applied" && !discard) {
    throw new WorktreeError(
      "confirmation_required",
      "Pass --discard to remove a session whose reviewed changes were not applied.",
    );
  }
  await runGit(session.sourceRoot, ["worktree", "remove", "--force", session.worktreeRoot]);
  await rm(session.sessionRoot, { recursive: true, force: true });
}

/**
 * Dispose predecessor sessions from oldest to newest. The current session is
 * intentionally not included so it remains available if predecessor cleanup
 * fails and the caller needs to retry the operation.
 *
 * @param {string | null} retryOf
 * @param {string} sourceRoot
 */
async function disposeRetryChain(retryOf, sourceRoot) {
  const sessions = await readRetryChain(retryOf, sourceRoot);
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (session === undefined) {
      continue;
    }
    await disposeSession(session, session.phase !== "applied");
  }
}

/**
 * Create an isolated worktree that starts with a staged copy of the source
 * worktree state. Its index is the pre-Qoder baseline.
 *
 * @param {string} cwd
 * @param {string | undefined} retryOf
 * @returns {Promise<WorktreeSession>}
 */
export async function prepareWorktree(cwd, retryOf = undefined) {
  const repository = await resolveRepository(cwd);
  let retrySession = null;
  if (retryOf !== undefined) {
    retrySession = await readSession(retryOf);
    if (resolve(retrySession.sourceRoot) !== resolve(repository.sourceRoot)) {
      throw new WorktreeError(
        "invalid_input",
        "--retry-of must refer to a session from the same source worktree.",
      );
    }
  }
  const sessionRoot = await mkdtemp(join(tmpdir(), SESSION_PREFIX));
  const worktreeRoot = join(sessionRoot, "worktree");
  const statePath = join(sessionRoot, STATE_FILE_NAME);
  const baselinePatchPath = join(sessionRoot, "source-baseline.patch");
  const reviewPatchPath = join(sessionRoot, PATCH_FILE_NAME);
  const worktreeRelativeCwd = relative(repository.sourceRoot, repository.sourceCwd);
  const worktreeCwd = resolve(worktreeRoot, worktreeRelativeCwd);
  assertInside(worktreeRoot, worktreeCwd);

  try {
    const sourcePatch = await runGit(repository.sourceRoot, ["diff", "--binary", "HEAD"]);
    await writeFile(baselinePatchPath, sourcePatch, { mode: 0o600 });
    await runGit(repository.sourceRoot, [
      "worktree",
      "add",
      "--detach",
      worktreeRoot,
      repository.baseCommit,
    ]);
    if (sourcePatch !== "") {
      await runGit(worktreeRoot, ["apply", "--binary", "--index", baselinePatchPath]);
    }
    for (const path of await listUntrackedFiles(repository.sourceRoot)) {
      await copyUntrackedFile(repository.sourceRoot, worktreeRoot, path);
    }
    await runGit(worktreeRoot, ["add", "--all"]);
    const baselineTree = (await runGit(worktreeRoot, ["write-tree"])).trim();
    /** @type {WorktreeSession} */
    const session = {
      version: WORKTREE_SESSION_VERSION,
      phase: "prepared",
      sessionRoot,
      statePath,
      sourceRoot: repository.sourceRoot,
      sourceCwd: repository.sourceCwd,
      worktreeRoot,
      worktreeCwd,
      baseCommit: repository.baseCommit,
      baselineTree,
      baselinePatchPath,
      reviewPatchPath,
      retryOf: retrySession?.statePath ?? null,
    };
    await writeSession(session);
    return session;
  } catch (error) {
    await runGit(repository.sourceRoot, ["worktree", "remove", "--force", worktreeRoot], {
      allowExitCodes: [0, 128],
    }).catch(() => undefined);
    await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Inspect candidate changes without staging files, generating a patch, or
 * advancing the session phase. This keeps an interrupted prepared worktree
 * eligible for an explicitly approved recovery continuation.
 *
 * @param {string} statePath
 * @returns {Promise<{session: WorktreeSession, hasChanges: boolean, changedFiles: string[], indexModified: boolean}>}
 */
export async function inspectWorktree(statePath) {
  const session = await readSession(statePath);
  const tracked = (
    await runGit(session.worktreeRoot, ["diff", "--name-only", "-z", session.baselineTree])
  )
    .split("\0")
    .filter((path) => path !== "");
  const staged = (
    await runGit(session.worktreeRoot, [
      "diff",
      "--name-only",
      "--cached",
      "-z",
      session.baselineTree,
    ])
  )
    .split("\0")
    .filter((path) => path !== "");
  const untracked = await listUntrackedFiles(session.worktreeRoot);
  const changedFiles = [...new Set([...tracked, ...untracked])].sort();
  return {
    session,
    hasChanges: changedFiles.length > 0,
    changedFiles,
    indexModified: staged.length > 0,
  };
}

/**
 * Stage the post-Qoder state only in the temporary worktree, then emit the
 * binary patch from the preserved baseline to that state.
 *
 * @param {string} statePath
 * @returns {Promise<{session: WorktreeSession, changedFiles: string[]}>}
 */
export async function createReviewPatch(statePath) {
  const session = await readSession(statePath);
  if (session.phase !== "prepared") {
    throw new WorktreeError(
      "invalid_state",
      "A review patch can be created only once per prepared session.",
    );
  }
  const currentIndexTree = (await runGit(session.worktreeRoot, ["write-tree"])).trim();
  if (currentIndexTree !== session.baselineTree) {
    throw new WorktreeError(
      "git_index_modified",
      "Qoder changed the temporary Git index; stop rather than generating a review patch.",
    );
  }
  await runGit(session.worktreeRoot, ["add", "--all"]);
  const patch = await runGit(session.worktreeRoot, [
    "diff",
    "--binary",
    "--cached",
    session.baselineTree,
  ]);
  await writeFile(session.reviewPatchPath, patch, { mode: 0o600 });
  const changedFiles = (
    await runGit(session.worktreeRoot, ["diff", "--name-only", "--cached", session.baselineTree])
  )
    .split("\n")
    .filter((path) => path !== "");
  session.phase = "review_ready";
  await writeSession(session);
  return { session, changedFiles };
}

/**
 * Apply the reviewed Qoder-only patch to the original source worktree without
 * staging it, then dispose the temporary worktree. A failed preflight leaves
 * both the source and the review session untouched.
 *
 * @param {string} statePath
 * @returns {Promise<WorktreeSession>}
 */
export async function applyReviewPatch(statePath) {
  const session = await readSession(statePath);
  if (session.phase !== "review_ready") {
    throw new WorktreeError(
      "invalid_state",
      "Apply is allowed only after the review patch is ready.",
    );
  }
  try {
    await runGit(session.sourceRoot, ["apply", "--check", "--binary", session.reviewPatchPath]);
  } catch {
    throw new WorktreeError(
      "apply_conflict",
      "The reviewed Qoder patch no longer applies cleanly; the source worktree was not modified.",
    );
  }
  await runGit(session.sourceRoot, ["apply", "--binary", session.reviewPatchPath]);
  session.phase = "applied";
  await writeSession(session);
  try {
    await disposeRetryChain(session.retryOf, session.sourceRoot);
    await disposeSession(session, false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown cleanup failure.";
    throw new WorktreeError(
      "cleanup_failed",
      `The reviewed Qoder patch was applied, but the temporary worktree could not be removed: ${detail}`,
    );
  }
  return session;
}

/**
 * @param {string} statePath
 * @param {boolean} discard
 */
export async function disposeWorktree(statePath, discard) {
  const session = await readSession(statePath);
  await disposeSession(session, discard);
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.command === "prepare") {
    const session = await prepareWorktree(/** @type {string} */ (parsed.cwd), parsed.retryOf);
    return {
      status: "succeeded",
      operation: "prepare",
      statePath: session.statePath,
      worktreeRoot: session.worktreeRoot,
      qoderCwd: session.worktreeCwd,
      retryOf: session.retryOf,
    };
  }
  if (parsed.command === "inspect") {
    const result = await inspectWorktree(/** @type {string} */ (parsed.state));
    return {
      status: "succeeded",
      operation: "inspect",
      phase: result.session.phase,
      statePath: result.session.statePath,
      qoderCwd: result.session.worktreeCwd,
      hasChanges: result.hasChanges,
      changedFiles: result.changedFiles,
      indexModified: result.indexModified,
    };
  }
  if (parsed.command === "diff") {
    const result = await createReviewPatch(/** @type {string} */ (parsed.state));
    return {
      status: "succeeded",
      operation: "diff",
      statePath: result.session.statePath,
      worktreeRoot: result.session.worktreeRoot,
      patchPath: result.session.reviewPatchPath,
      baselineTree: result.session.baselineTree,
      changedFiles: result.changedFiles,
    };
  }
  if (parsed.command === "apply") {
    const session = await applyReviewPatch(/** @type {string} */ (parsed.state));
    return { status: "succeeded", operation: "apply", statePath: session.statePath, cleaned: true };
  }
  await disposeWorktree(/** @type {string} */ (parsed.state), parsed.discard);
  return { status: "succeeded", operation: "dispose" };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
  } catch (error) {
    const code = error instanceof WorktreeError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : "Worktree coordinator failed.";
    process.stdout.write(`${JSON.stringify({ status: "failed", error: { code, message } })}\n`);
    process.exitCode = 1;
  }
}
