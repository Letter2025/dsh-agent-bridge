import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { runGit } from "./git-client";
import { assertInside } from "./paths";
import { copyUntrackedFile } from "./repository";
import {
  MAX_INCLUDED_ARTIFACT_BYTES,
  MAX_INCLUDED_ARTIFACT_FILES,
  WorktreeError,
  type IncludedArtifactManifest,
  type IncludedArtifactManifestEntry,
  type IncludedIgnoredArtifacts,
} from "./types";

const CONFIG_FILE_NAME = ".qoderinclude";

interface IncludeRule {
  source: string;
  pattern: string;
  exclude: boolean;
  line: number;
}

interface IncludedArtifactConfig {
  configPath: string;
  rules: IncludeRule[];
}

function invalidConfig(message: string): never {
  throw new WorktreeError("invalid_include_config", message);
}

function validateBalancedBrackets(value: string, line: number): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "[") continue;
    let contentStart = index + 1;
    if (value[contentStart] === "!" || value[contentStart] === "^") contentStart += 1;
    if (value[contentStart] === "]") contentStart += 1;
    const close = value.indexOf("]", contentStart);
    if (close === -1) {
      invalidConfig(`.qoderinclude line ${line} has an invalid character group.`);
    }
    index = close;
  }
}

function parseRule(source: string, line: number): IncludeRule | null {
  let value = source.trim();
  if (value === "" || value.startsWith("#")) return null;

  let exclude = false;
  if (value.startsWith("\\#") || value.startsWith("\\!")) {
    value = value.slice(1);
  } else if (value.startsWith("!")) {
    exclude = true;
    value = value.slice(1).trim();
  }
  if (value === "") invalidConfig(`.qoderinclude line ${line} has an empty pattern.`);
  if (value.includes("\0")) invalidConfig(`.qoderinclude line ${line} contains a NUL byte.`);
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("//")) {
    invalidConfig(`.qoderinclude line ${line} must be repository-relative.`);
  }
  if (value.startsWith("/")) value = value.slice(1);
  if (isAbsolute(value)) {
    invalidConfig(`.qoderinclude line ${line} must be repository-relative.`);
  }

  const segments = value.split("/");
  if (segments.includes("..")) {
    invalidConfig(`.qoderinclude line ${line} may not escape the repository.`);
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    invalidConfig(`.qoderinclude line ${line} may not select .git.`);
  }
  validateBalancedBrackets(value, line);
  if (value.endsWith("/")) value += "**";
  const stored = exclude ? `!${value}` : /^[#!]/u.test(value) ? `\\${value}` : value;
  return { source: stored, pattern: value, exclude, line };
}

export async function readIncludedArtifactConfig(
  sourceRoot: string,
): Promise<IncludedArtifactConfig | null> {
  const configPath = resolve(sourceRoot, CONFIG_FILE_NAME);
  let bytes: Buffer;
  try {
    const information = await lstat(configPath);
    if (!information.isFile() || information.isSymbolicLink()) {
      invalidConfig(".qoderinclude must be a regular file in the repository root.");
    }
    bytes = await readFile(configPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidConfig(".qoderinclude must contain valid UTF-8 text.");
  }
  if (contents.charCodeAt(0) === 0xfeff) contents = contents.slice(1);
  const rules = contents
    .split(/\r?\n/u)
    .map((line, index) => parseRule(line, index + 1))
    .filter((rule): rule is IncludeRule => rule !== null);
  return { configPath, rules };
}

async function selectPaths(root: string, rules: IncludeRule[], scope: string): Promise<string[]> {
  const selected = new Set<string>();
  const selectedSpecial = new Set<string>();
  for (const rule of rules) {
    const matches = await listRuleMatches(root, rule);
    for (const path of matches) {
      if (rule.exclude) selected.delete(path);
      else selected.add(path);
    }
    for (const path of await listRuleSpecialMatches(root, rule)) {
      if (!isWithinScope(path, scope)) continue;
      if (rule.exclude) selectedSpecial.delete(path);
      else selectedSpecial.add(path);
    }
  }
  const unsupported = [...selectedSpecial].sort()[0];
  if (unsupported !== undefined) {
    throw new WorktreeError(
      "unsupported_included_artifact",
      `Included artifact ${unsupported} must be a regular file or symbolic link.`,
    );
  }
  return [...selected].sort();
}

function gitPathspec(rule: IncludeRule): string {
  return `:(top,glob)${rule.pattern}`;
}

async function listRuleMatches(root: string, rule: IncludeRule): Promise<string[]> {
  try {
    const output = await runGit(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      gitPathspec(rule),
    ]);
    return output.split("\0").filter((path) => path !== "");
  } catch (error) {
    if (error instanceof WorktreeError && error.code === "git_failed") {
      invalidConfig(`.qoderinclude line ${rule.line} contains an invalid glob pattern.`);
    }
    throw error;
  }
}

async function readDirectory(root: string, path: string) {
  try {
    return await readdir(resolve(root, path), { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return [];
    }
    throw error;
  }
}

async function listRuleSpecialMatches(root: string, rule: IncludeRule): Promise<string[]> {
  const matches = new Set<string>();
  const segments = rule.pattern.split("/");
  const consider = async (
    path: string,
    isFile: boolean,
    isSymbolicLink: boolean,
    isDirectory: boolean,
  ) => {
    if (isFile || isSymbolicLink || isDirectory || !matchesGlob(path, rule.pattern)) return;
    const ignored = await runGit(root, ["check-ignore", "--no-index", "--", path], {
      allowExitCodes: [0, 1],
    });
    if (ignored !== "") matches.add(path);
  };
  const visitAll = async (directory: string): Promise<void> => {
    for (const entry of await readDirectory(root, directory)) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      await consider(path, entry.isFile(), entry.isSymbolicLink(), entry.isDirectory());
      if (entry.isDirectory()) await visitAll(path);
    }
  };
  const visitSegments = async (directory: string, index: number): Promise<void> => {
    const segment = segments[index];
    if (segment === undefined) return;
    if (segment === "**") {
      await visitAll(directory);
      return;
    }
    const isLast = index === segments.length - 1;
    for (const entry of await readDirectory(root, directory)) {
      if (!matchesGlob(entry.name, segment)) continue;
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (isLast) await consider(path, entry.isFile(), entry.isSymbolicLink(), entry.isDirectory());
      else if (entry.isDirectory()) await visitSegments(path, index + 1);
    }
  };
  await visitSegments("", 0);
  return [...matches];
}

function isWithinScope(path: string, scope: string): boolean {
  return scope === "" || path === scope || path.startsWith(`${scope}/`);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function describeArtifact(
  root: string,
  path: string,
): Promise<IncludedArtifactManifestEntry> {
  const absolutePath = resolve(root, path);
  assertInside(root, absolutePath);
  const information = await lstat(absolutePath);
  const mode = information.mode & 0o7777;
  if (information.isFile()) {
    try {
      assertInside(await realpath(root), await realpath(absolutePath));
    } catch {
      throw new WorktreeError(
        "unsupported_included_artifact",
        `Included artifact ${path} must resolve inside the repository.`,
      );
    }
    return {
      path,
      type: "file",
      mode,
      size: information.size,
      sha256: await hashFile(absolutePath),
    };
  }
  if (information.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    if (isAbsolute(target)) {
      throw new WorktreeError(
        "unsupported_included_artifact",
        `Included symlink ${path} must use a repository-internal relative target.`,
      );
    }
    const lexicalTarget = resolve(dirname(absolutePath), target);
    try {
      assertInside(root, lexicalTarget);
      const resolvedTarget = await realpath(absolutePath);
      assertInside(await realpath(root), resolvedTarget);
      if (!(await stat(resolvedTarget)).isFile()) throw new Error("not a regular file");
    } catch {
      throw new WorktreeError(
        "unsupported_included_artifact",
        `Included symlink ${path} must resolve to a regular file inside the repository.`,
      );
    }
    return {
      path,
      type: "symlink",
      mode,
      size: information.size,
      sha256: createHash("sha256").update(target).digest("hex"),
    };
  }
  throw new WorktreeError(
    "unsupported_included_artifact",
    `Included artifact ${path} must be a regular file or symbolic link.`,
  );
}

async function describeArtifacts(
  root: string,
  paths: string[],
): Promise<IncludedArtifactManifestEntry[]> {
  enforceIncludedArtifactLimits(paths.length, 0);
  let projectedBytes = 0;
  for (const path of paths) {
    projectedBytes += (await lstat(resolve(root, path))).size;
    enforceIncludedArtifactLimits(paths.length, projectedBytes);
  }
  const entries: IncludedArtifactManifestEntry[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const entry = await describeArtifact(root, path);
    totalBytes += entry.size;
    enforceIncludedArtifactLimits(paths.length, totalBytes);
    entries.push(entry);
  }
  return entries;
}

export function enforceIncludedArtifactLimits(fileCount: number, totalBytes: number): void {
  if (fileCount > MAX_INCLUDED_ARTIFACT_FILES) {
    throw new WorktreeError(
      "include_limit_exceeded",
      `.qoderinclude selected more than ${MAX_INCLUDED_ARTIFACT_FILES} files.`,
    );
  }
  if (totalBytes > MAX_INCLUDED_ARTIFACT_BYTES) {
    throw new WorktreeError(
      "include_limit_exceeded",
      `.qoderinclude selected more than ${MAX_INCLUDED_ARTIFACT_BYTES} bytes.`,
    );
  }
}

export async function prepareIncludedArtifacts(
  sourceRoot: string,
  sourceCwd: string,
  worktreeRoot: string,
  manifestPath: string,
): Promise<IncludedIgnoredArtifacts | null> {
  const config = await readIncludedArtifactConfig(sourceRoot);
  if (config === null || config.rules.length === 0) return null;
  const sourceScope = relative(sourceRoot, sourceCwd).split(sep).join("/");
  const selected = await selectPaths(sourceRoot, config.rules, sourceScope);
  const scoped = selected.filter((path) => isWithinScope(path, sourceScope));
  const sourceEntries = await describeArtifacts(sourceRoot, scoped);
  for (const entry of sourceEntries) {
    await copyUntrackedFile(sourceRoot, worktreeRoot, entry.path);
  }
  const entries = await describeArtifacts(
    worktreeRoot,
    sourceEntries.map((entry) => entry.path),
  );
  const manifest: IncludedArtifactManifest = { version: 1, entries };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestContents, { mode: 0o600 });
  return {
    configPath: config.configPath,
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestContents).digest("hex"),
    rules: config.rules.map((rule) => rule.source),
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
  };
}

export async function readIncludedArtifactManifestPaths(
  session: Pick<import("./types").WorktreeSession, "worktreeRoot" | "includedIgnoredArtifacts">,
): Promise<string[]> {
  const included = session.includedIgnoredArtifacts;
  if (included === null) return [];
  let contents: string;
  let manifest: IncludedArtifactManifest;
  try {
    contents = await readFile(included.manifestPath, "utf8");
    manifest = JSON.parse(contents) as IncludedArtifactManifest;
  } catch {
    throw new WorktreeError(
      "included_artifact_snapshot_invalid",
      "Included artifact manifest is unreadable.",
    );
  }
  if (
    included.manifestSha256 !== null &&
    createHash("sha256").update(contents).digest("hex") !== included.manifestSha256
  )
    throw new WorktreeError(
      "included_artifact_snapshot_invalid",
      "Included artifact manifest digest does not match the prepared session.",
    );
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.path !== "string" ||
        entry.path === "" ||
        isAbsolute(entry.path) ||
        entry.path.split("/").some((segment) => segment === "" || segment === "..") ||
        entry.path.split("/").some((segment) => segment.toLowerCase() === ".git") ||
        !["file", "symlink"].includes(entry.type) ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o7777 ||
        !Number.isInteger(entry.size) ||
        entry.size < 0 ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256),
    )
  ) {
    throw new WorktreeError(
      "included_artifact_snapshot_invalid",
      "Included artifact manifest is invalid.",
    );
  }
  const paths = manifest.entries.map((entry) => entry.path);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path) => {
      try {
        assertInside(session.worktreeRoot, resolve(session.worktreeRoot, path));
        return false;
      } catch {
        return true;
      }
    }) ||
    paths.length !== included.fileCount ||
    manifest.entries.reduce((total, entry) => total + entry.size, 0) !== included.totalBytes
  ) {
    throw new WorktreeError(
      "included_artifact_snapshot_invalid",
      "Included artifact manifest does not match the prepared session summary.",
    );
  }
  return paths;
}
