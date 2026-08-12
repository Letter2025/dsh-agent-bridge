# Isolated Qoder Worktree Review

Use the coordinator for a code-changing Qoder task in a Git worktree. It does
not invoke Qoder; Qoder must still run only through `run_qoder.mjs`.

## Lifecycle

1. Record source `git status` and relevant diffs without altering the source.
2. Run `qoder_worktree.mjs prepare --cwd <source-cwd>`. It returns `statePath`,
   `worktreeRoot`, and `qoderCwd` as one JSON object. The coordinator starts at
   `HEAD`, mirrors source tracked changes and non-ignored untracked files, then
   stages that copied state only in the temporary worktree as Qoder's baseline.
   Ignored dependencies such as `node_modules` are not copied, linked, or
   installed. Reuse a trustworthy existing session for review corrections and
   failed-Runner recovery. Use `--retry-of <previous-statePath>` only for an
   explicitly requested clean restart or when the predecessor cannot be safely
   continued; it must belong to the same source worktree.
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
   and run checks in `<qoderCwd>`. If the candidate passes, present that
   evidence and wait for explicit user approval. If it has a concrete in-scope
   defect, use the correction lifecycle below before presenting a candidate.
7. Only after a passing candidate receives approval, run
   `qoder_worktree.mjs apply --state <statePath>`.
   It runs `git apply --check --binary` against the source first, then applies
   the patch without staging it. After a successful application it automatically
   removes the temporary worktree and session. It never creates a commit or
   forces a patch.
8. If application fails, keep the temporary worktree and any linked
   predecessors for diagnosis. If a retry was created with `--retry-of`, a
   successful apply disposes the new session and its linked predecessor chain.
   If the patch was applied but automatic cleanup failed, retry the
   coordinator's `dispose` command with the current `--state <statePath>`.
   To discard an un-applied or failed chain, require an explicit discard
   instruction and pass `--discard` to each retained session.

Every coordinator command must receive narrowly scoped host execution. Do not
grant reusable arbitrary shell or Node access.

## Review Corrections

The original explicit data-transfer authorization covers at most two automatic
correction runs after the initial successful Runner execution when independent
review finds only concrete, verifiable, in-scope defects and the objective,
data categories, `qoderCwd`, and change scope remain unchanged. Do not ask for
conversational approval solely to start such a run. Run `qoder_worktree.mjs
reopen --state <statePath>`.
It verifies the reviewed state, archives the rejected patch as
`qoder-only.attempt-<n>.patch`, restores only the temporary index to the source
baseline, and returns the same `qoderCwd` with all candidate files intact.
Reissue the complete original task plus review findings in a distinct brief,
then generate and independently review the new complete patch.

Stop without correction when the finding requires a material user decision,
scope expansion, or a third correction run. Runner failures follow the normal
failure rules, not this review-correction lifecycle. Final patch application
always requires explicit user approval.

## Failed-Runner Recovery

After any Runner execution failure, wait until Runner and Qoder have ended and
inspect the prepared session without generating its review patch. If the index
is unchanged, every edit is explainable and in scope, and the original task and
baseline still apply, an explicitly approved continuation must use the same
`qoderCwd` and preserve its partial work. Resolve external prerequisites first,
use a distinct recovery brief, and restate in the approval prompt that the same
task-required private or project content will be sent to Qoder's external
service. Stop if the same hard failure repeats. For the exact retryable
`model_queue_exhausted` code, allow at most one recovery. Do not broaden
permissions or retry automatically.

## Stop Conditions

Stop rather than bypassing a condition when:

- the source is not a Git worktree, has no `HEAD` commit, or has unmerged
  paths;
- the task needs ignored artifacts that the coordinator does not mirror;
- the Runner reports a failure whose processes are still live, state cannot be
  explained, or temporary Git index was changed;
- `reopen` detects that a reviewed worktree drifted after patch generation;
- the review patch is empty but Qoder claims code changes;
- source changes make `apply --check` fail;
- the patch is applied but automatic worktree cleanup fails.

The source may have unrelated staged or unstaged changes. The patch application
checks only Qoder's affected content and preserves the source index. After
application, ordinary Git status shows the resulting combined worktree state;
it does not retain author attribution.
