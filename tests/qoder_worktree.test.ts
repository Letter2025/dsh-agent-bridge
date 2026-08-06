import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReviewPatch,
  createReviewPatch,
  disposeWorktree,
  parseArgs,
  prepareWorktree,
} from "../skill/qoder-agent/scripts/qoder_worktree.mjs";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
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
    expect(() => parseArgs(["prepare", "--cwd", "relative"])).not.toThrow();
    expect(() => parseArgs(["prepare", "--state", "/tmp/session.json"])).toThrow(
      /prepare requires/,
    );
    expect(() => parseArgs(["diff", "--state", "/tmp/session.json", "--discard"])).toThrow(
      /diff requires/,
    );
    expect(() => parseArgs(["dispose", "--state", "/tmp/session.json", "--discard"])).not.toThrow();
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
    const review = await createReviewPatch(session.statePath);

    expect(review.changedFiles).toEqual(["qoder-new.txt", "tracked.txt"]);
    expect(await readFile(session.reviewPatchPath, "utf8")).toContain("qoder result");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("user working\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep this baseline\n");

    await applyReviewPatch(session.statePath);

    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("qoder result\n");
    expect(await readFile(join(root, "qoder-new.txt"), "utf8")).toBe("new code\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep this baseline\n");
    expect(git(root, ["diff", "--cached", "--", "tracked.txt"])).toContain("user staged");

    await disposeWorktree(session.statePath, false);
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

    await disposeWorktree(session.statePath, true);
  });

  it("stops if Qoder changes the temporary Git index", async () => {
    const root = await createFixture();
    const session = await prepareWorktree(root);
    await writeFile(join(session.worktreeRoot, "tracked.txt"), "staged by qoder\n");
    git(session.worktreeRoot, ["add", "tracked.txt"]);

    await expect(createReviewPatch(session.statePath)).rejects.toMatchObject({
      code: "git_index_modified",
    });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");

    await disposeWorktree(session.statePath, true);
  });
});
