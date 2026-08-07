# Isolated Qoder Worktree Review

Use the coordinator for a code-changing Qoder task in a Git worktree. It does
not invoke Qoder; Qoder must still run only through `run_qoder.mjs`.

## Lifecycle

1. Record source `git status` and relevant diffs without altering the source.
2. Run `qoder_worktree.mjs prepare --cwd <source-cwd>`. It returns `statePath`,
   `worktreeRoot`, and `qoderCwd` as one JSON object. The coordinator starts at
   `HEAD`, mirrors source tracked changes and non-ignored untracked files, then
   stages that copied state only in the temporary worktree as Qoder's baseline.
3. Run the Runner with `--cwd <qoderCwd>`. Qoder must not change the temporary
   Git index or worktree setup.
4. If inspection is needed before review, run `qoder_worktree.mjs inspect
--state <statePath>`. It reports candidate changes and index modification
   without staging files or advancing the session phase.
5. Run `qoder_worktree.mjs diff --state <statePath>`. It stages only in the
   temporary worktree and writes `qoder-only.patch`, the binary diff from the
   preserved baseline to Qoder's result. The JSON response lists changed files
   and returns `baselineTree` for direct Git review.
6. Inspect `git -C <worktreeRoot> diff --cached <baselineTree>` or the patch,
   and run checks in `<qoderCwd>`. Present that evidence and wait for explicit
   user approval.
7. Only after approval, run `qoder_worktree.mjs apply --state <statePath>`.
   It runs `git apply --check --binary` against the source first, then applies
   the patch without staging it. It never creates a commit or forces a patch.
8. Keep the temporary worktree for follow-up review. After successful
   application, dispose it with `dispose --state <statePath>`. To discard an
   un-applied or failed session, require an explicit discard instruction and
   run `dispose --state <statePath> --discard`.

Every coordinator command must receive narrowly scoped host execution. Do not
grant reusable arbitrary shell or Node access.

## Queue Recovery

When the Runner returns `model_queue_exhausted`, inspect the prepared session
without generating its review patch. After explicit user approval, allow one
continuation in the same `qoderCwd` with the original task restated and a
direction to repair existing edits. Do not create a new worktree or baseline,
and do not apply this exception to any other failure.

## Stop Conditions

Stop rather than bypassing a condition when:

- the source is not a Git worktree, has no `HEAD` commit, or has unmerged
  paths;
- the task needs ignored artifacts that the coordinator does not mirror;
- the Runner reports a failure or Qoder changes the temporary Git index;
- the review patch is empty but Qoder claims code changes;
- source changes make `apply --check` fail.

The source may have unrelated staged or unstaged changes. The patch application
checks only Qoder's affected content and preserves the source index. After
application, ordinary Git status shows the resulting combined worktree state;
it does not retain author attribution.
