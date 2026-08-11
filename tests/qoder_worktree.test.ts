import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReviewPatch,
  createReviewPatch,
  disposeWorktree,
  inspectWorktree,
  prepareWorktree,
  reopenReviewWorktree,
} from "@qoder-agent-bridge/core";
import { executeWorktreeCommand, parseWorktreeArgs } from "../packages/cli/src/qoder-worktree";

const fixtures: string[] = [];
const worktreeRunnerPath = fileURLToPath(
  new URL("../skill/qoder-agent/scripts/qoder_worktree.mjs", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "qoder-worktree-test-"));
  fixtures.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Qoder Worktree Test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("Qoder isolated worktree coordinator", () => {
  it("validates its narrow lifecycle arguments", () => {
    expect(() => parseWorktreeArgs(["prepare", "--cwd", "relative"])).not.toThrow();
    expect(
      parseWorktreeArgs(["prepare", "--cwd", "relative", "--retry-of", "/tmp/session.json"]),
    ).toMatchObject({ retryOf: "/tmp/session.json" });
    expect(() => parseWorktreeArgs(["prepare", "--state", "/tmp/session.json"])).toThrow(
      /prepare requires/,
    );
    expect(() => parseWorktreeArgs(["diff", "--state", "/tmp/session.json", "--discard"])).toThrow(
      /diff requires/,
    );
    expect(() => parseWorktreeArgs(["inspect", "--state", "/tmp/session.json"])).not.toThrow();
    expect(() => parseWorktreeArgs(["reopen", "--state", "/tmp/session.json"])).not.toThrow();
    expect(() =>
      parseWorktreeArgs(["dispose", "--state", "/tmp/session.json", "--discard"]),
    ).not.toThrow();
    expect(() =>
      parseWorktreeArgs(["apply", "--state", "/tmp/session.json", "--retry-of", "/tmp/old.json"]),
    ).toThrow(/apply requires/);
  });

  it("reviews and applies only Qoder changes over a dirty source baseline", async () => {
    const root = await createFixture();
    await writeFile(join(root, "tracked.txt"), "user staged\n");
    git(root, ["add", "tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "user working\n");
    await writeFile(join(root, "untracked.txt"), "keep this baseline\n");

    const session = await prepareWorktree(root);
    expect(await readFile(join(session.worktreeRoot, "tracked.txt"), "utf8")).toBe(
      "user working\n",
    );
    expect(await readFile(join(session.worktreeRoot, "untracked.txt"), "utf8")).toBe(
      "keep this baseline\n",
    );
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("user working\n");

    await writeFile(join(session.worktreeRoot, "tracked.txt"), "qoder result\n");
    await writeFile(join(session.worktreeRoot, "qoder-new.txt"), "new code\n");
    const inspection = await inspectWorktree(session.statePath);
    expect(inspection).toMatchObject({
      hasChanges: true,
      changedFiles: ["qoder-new.txt", "tracked.txt"],
      indexModified: false,
      session: { phase: "prepared" },
    });
    const review = await createReviewPatch(session.statePath);

    expect(review.changedFiles).toEqual(["qoder-new.txt", "tracked.txt"]);
    expect(await readFile(session.reviewPatchPath, "utf8")).toContain("qoder result");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("user working\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep this baseline\n");

    await expect(
      executeWorktreeCommand(["apply", "--state", session.statePath]),
    ).resolves.toMatchObject({
      status: "succeeded",
      operation: "apply",
      cleaned: true,
    });

    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("qoder result\n");
    expect(await readFile(join(root, "qoder-new.txt"), "utf8")).toBe("new code\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep this baseline\n");
    expect(git(root, ["diff", "--cached", "--", "tracked.txt"])).toContain("user staged");
    expect(await pathExists(session.worktreeRoot)).toBe(false);
    expect(await pathExists(session.sessionRoot)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(session.worktreeRoot);
  });

  it("does not modify the source when the reviewed patch no longer applies", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "qoder result\n");
    await createReviewPatch(session.statePath);
    await writeFile(join(root, "tracked.txt"), "concurrent source edit\n");

    await expect(applyReviewPatch(session.statePath)).rejects.toMatchObject({
      code: "apply_conflict",
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("concurrent source edit\n");
    expect(await pathExists(session.worktreeRoot)).toBe(true);
    expect(await pathExists(session.sessionRoot)).toBe(true);

    await disposeWorktree(session.statePath, true);
    expect(await pathExists(session.worktreeRoot)).toBe(false);
    expect(await pathExists(session.sessionRoot)).toBe(false);
  });

  it("reopens a rejected candidate in place and applies the corrected complete result", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "accepted first-pass work\n");
    await writeFile(join(session.worktreeRoot, "qoder-new.txt"), "broken first pass\n");
    const firstReview = await createReviewPatch(session.statePath);
    const firstPatch = await readFile(firstReview.session.reviewPatchPath, "utf8");

    const reopened = await executeWorktreeCommand(["reopen", "--state", session.statePath]);
    expect(reopened).toMatchObject({
      status: "succeeded",
      operation: "reopen",
      phase: "prepared",
      statePath: await realpath(session.statePath),
      qoderCwd: session.worktreeCwd,
      changedFiles: ["qoder-new.txt", "tracked.txt"],
      indexModified: false,
      reviewAttempt: 1,
    });
    expect(await readFile(join(session.worktreeRoot, "tracked.txt"), "utf8")).toBe(
      "accepted first-pass work\n",
    );
    expect(await readFile(join(session.worktreeRoot, "qoder-new.txt"), "utf8")).toBe(
      "broken first pass\n",
    );
    expect(await readFile(String(reopened.archivedPatchPath), "utf8")).toBe(firstPatch);
    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      indexModified: false,
      session: { phase: "prepared", reviewAttempt: 1 },
    });

    await writeFile(join(session.worktreeRoot, "qoder-new.txt"), "fixed second pass\n");
    const secondReview = await createReviewPatch(session.statePath);
    expect(secondReview.session.reviewAttempt).toBe(2);
    const finalPatch = await readFile(session.reviewPatchPath, "utf8");
    expect(finalPatch).toContain("accepted first-pass work");
    expect(finalPatch).toContain("fixed second pass");

    await applyReviewPatch(session.statePath);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("accepted first-pass work\n");
    expect(await readFile(join(root, "qoder-new.txt"), "utf8")).toBe("fixed second pass\n");
  });

  it("refuses to reopen a reviewed worktree that drifted after patch generation", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "reviewed candidate\n");
    await createReviewPatch(session.statePath);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "post-review drift\n");

    await expect(reopenReviewWorktree(session.statePath)).rejects.toMatchObject({
      code: "review_state_changed",
    });
    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      session: { phase: "review_ready", reviewAttempt: 1 },
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");

    await disposeWorktree(session.statePath, true);
  });

  it("continues a trustworthy failed Runner attempt in the same prepared worktree", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "partial failed-run work\n");

    const failedRunInspection = await executeWorktreeCommand([
      "inspect",
      "--state",
      session.statePath,
    ]);
    expect(failedRunInspection).toMatchObject({
      phase: "prepared",
      qoderCwd: session.worktreeCwd,
      hasChanges: true,
      changedFiles: ["tracked.txt"],
      indexModified: false,
    });

    await writeFile(join(session.worktreeRoot, "tracked.txt"), "completed recovery work\n");
    await createReviewPatch(session.statePath);
    await applyReviewPatch(session.statePath);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("completed recovery work\n");
  });

  it("disposes a linked retry chain after the newest session applies", async () => {
    const root = await createFixture();
    const first = await prepareWorktree(root);
    await writeFile(join(first.worktreeRoot, "tracked.txt"), "partial retry result\n");

    const second = await prepareWorktree(root, first.statePath);
    expect(second.retryOf).toBe(await realpath(first.statePath));
    await writeFile(join(second.worktreeRoot, "tracked.txt"), "final retry result\n");
    await createReviewPatch(second.statePath);

    await expect(
      executeWorktreeCommand(["apply", "--state", second.statePath]),
    ).resolves.toMatchObject({
      status: "succeeded",
      operation: "apply",
      cleaned: true,
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("final retry result\n");
    expect(await pathExists(first.worktreeRoot)).toBe(false);
    expect(await pathExists(first.sessionRoot)).toBe(false);
    expect(await pathExists(second.worktreeRoot)).toBe(false);
    expect(await pathExists(second.sessionRoot)).toBe(false);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(first.worktreeRoot);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain(second.worktreeRoot);
  });

  it("retains a linked retry chain when the newest apply conflicts", async () => {
    const root = await createFixture();
    const first = await prepareWorktree(root);
    const second = await prepareWorktree(root, first.statePath);
    await writeFile(join(second.worktreeRoot, "tracked.txt"), "retry result\n");
    await createReviewPatch(second.statePath);
    await writeFile(join(root, "tracked.txt"), "concurrent source edit\n");

    await expect(applyReviewPatch(second.statePath)).rejects.toMatchObject({
      code: "apply_conflict",
    });
    expect(await pathExists(first.worktreeRoot)).toBe(true);
    expect(await pathExists(first.sessionRoot)).toBe(true);
    expect(await pathExists(second.worktreeRoot)).toBe(true);
    expect(await pathExists(second.sessionRoot)).toBe(true);

    await disposeWorktree(second.statePath, true);
    await disposeWorktree(first.statePath, true);
  });

  it("rejects a retry session from another source worktree", async () => {
    const firstRoot = await createFixture();
    const secondRoot = await createFixture();
    const first = await prepareWorktree(firstRoot);

    await expect(prepareWorktree(secondRoot, first.statePath)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await disposeWorktree(first.statePath, true);
  });

  it("requires discard before disposing an unapplied session", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);

    await expect(disposeWorktree(session.statePath, false)).rejects.toMatchObject({
      code: "confirmation_required",
    });
    expect(await pathExists(session.worktreeRoot)).toBe(true);

    await disposeWorktree(session.statePath, true);
    expect(await pathExists(session.worktreeRoot)).toBe(false);
    expect(await pathExists(session.sessionRoot)).toBe(false);
  });

  it("stops if Qoder changes the temporary Git index", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "staged by qoder\n");
    git(session.worktreeRoot, ["add", "tracked.txt"]);

    await expect(inspectWorktree(session.statePath)).resolves.toMatchObject({
      hasChanges: true,
      changedFiles: ["tracked.txt"],
      indexModified: true,
      session: { phase: "prepared" },
    });

    await expect(createReviewPatch(session.statePath)).rejects.toMatchObject({
      code: "git_index_modified",
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");

    await disposeWorktree(session.statePath, true);
  });
});

describe("generated worktree executable", () => {
  it("does not execute a command when imported", () => {
    const importScript = `await import(${JSON.stringify(pathToFileURL(worktreeRunnerPath).href)});`;
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", importScript], {
      encoding: "utf8",
    });

    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");
  });

  it("emits one JSON failure for invalid direct input", () => {
    const executed = spawnSync(process.execPath, [worktreeRunnerPath], { encoding: "utf8" });
    const lines = executed.stdout.trim().split("\n");
    const result = JSON.parse(lines[0] ?? "{}");

    expect(executed.status).not.toBe(0);
    expect(lines).toHaveLength(1);
    expect(executed.stderr).toBe("");
    expect(result).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
  });
});
