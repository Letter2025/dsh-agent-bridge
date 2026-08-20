# Isolated DSH Worktree Review

Use the coordinator for a code-changing DSH task in a Git worktree. It does
not invoke DSH; DSH must still run only through `run_dsh.mjs`.

## Lifecycle

1. Record source `git status` and relevant diffs without altering the source.
2. Run `dsh_worktree.mjs prepare --cwd <host-cwd>`, where `<host-cwd>` is the
   Codex session's authorized directory, normally the repository root. It
   returns `statePath`, `worktreeRoot`, and `dshCwd` as one JSON object. The coordinator starts at
   `HEAD`, mirrors source tracked changes and non-ignored untracked files, then
   stages that copied state only in the temporary worktree as DSH's baseline.
   A repository-root `.dshinclude` can select locally available ignored files as optional copied,
   unstaged check inputs; missing matches are allowed. `prepare` returns its config path, manifest, rules, file
   count, and bytes. Inspect the manifest and explicitly disclose the selected
   path categories and size before DSH receives them; configuration is not
   transfer authorization. Matching uses scoped Git pathspec queries plus a
   glob-directed special-file scan. The v2 session validates the manifest digest
   and all lifecycle operations exclude its prepared paths, even if those local
   copies change. Reuse a trustworthy existing session for review
   corrections and failed-Runner recovery. Use `--retry-of
<previous-statePath>` only for an
   explicitly requested clean restart or when the predecessor cannot be safely
   continued; it must belong to the same source worktree.
3. Run the Runner with `--cwd <dshCwd>`. This is the temporary worktree
   counterpart of the host boundary, not a directory inferred from the task's
   expected changed files. Keep the narrower task modification scope in the
   delegation brief. DSH must not change the temporary Git index or worktree
   setup.
4. If inspection is needed before review, run `dsh_worktree.mjs inspect
--state <statePath>`. It reports candidate changes and index modification
   without staging files or advancing the session phase.
5. Run `dsh_worktree.mjs diff --state <statePath>`. It stages only in the
   temporary worktree and writes `dsh-only.patch`, the binary diff from the
   preserved baseline to DSH's result. The JSON response lists changed files
   and returns `baselineTree` for direct Git review.
6. Inspect `git -C <worktreeRoot> diff --cached <baselineTree>` or the patch,
   and run checks in `<dshCwd>`. Treat changes outside the brief's narrower
   task scope as out-of-scope findings even when they are inside `dshCwd`.
   If the candidate passes, present that evidence and wait for explicit user
   approval. If it has a concrete in-scope defect, use the correction lifecycle
   below before presenting a candidate.
7. Only after a passing candidate receives approval, run
   `dsh_worktree.mjs apply --state <statePath>`.
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
data categories, `hostCwd`, `dshCwd`, and `taskScope` remain unchanged. Do not ask for
conversational approval solely to start such a run. Run `dsh_worktree.mjs
reopen --state <statePath>`.
It verifies the reviewed state, archives the rejected patch as
`dsh-only.attempt-<n>.patch`, restores only the temporary index to the source
baseline, and returns the same `dshCwd` with all candidate files intact.
Reissue the complete original task plus review findings in a distinct brief,
then generate and independently review the new complete patch. Preserve the
complete objective, required context, compiled rules, `taskScope`, acceptance
criteria, verification, assumptions, and stop conditions. Direct DSH to
inspect and repair the existing uncommitted changes; never send a findings-only
brief or rely on prior session memory. Store each correction brief under a
distinct filename and reapply Brief Review. Treat external transfer as already
authorized under `SKILL.md`'s decision policy: `required` uses Brief Review
only, while a precise in-scope `auto` correction needs no preview.

Stop without correction when the finding requires a material user decision,
scope expansion, or a third correction run. Runner failures follow the normal
failure rules, not this review-correction lifecycle. Final patch application
always requires explicit user approval.

## Failed-Runner Recovery

After any Runner execution failure, wait until Runner and DSH have ended and
run `dsh_worktree.mjs inspect --state <statePath>` without generating a review
patch. Continue only when `inspection.session.phase === "prepared"`,
`inspection.indexModified === false`, every edit is explainable and in
`taskScope`,
and the original task and baseline still apply. An explicitly approved
continuation must use the same `dshCwd` and preserve its partial work. Resolve
external prerequisites first, use a distinct recovery brief, and restate in the
approval prompt that the same task-required private or project content will be
sent to DSH's external service. Stop if the same hard failure repeats. For
DSH failures, allow at most one recovery after a concrete external prerequisite
has been fixed. The Runner never marks provider text as automatically retryable.
Do not broaden permissions or retry automatically.

For an approved recovery, reissue the complete original brief under a distinct
filename and change only the objective to:

```text
Continue the interrupted bounded task from the existing uncommitted changes in
this worktree. Inspect the current diff before editing and do not restart from
scratch.

Repair incomplete or invalid edits, complete the task, and run the relevant
checks. Do not commit, stage, stash, reset, clean, or modify Git worktree
configuration.
```

Preserve required context, compiled rules, `taskScope`, acceptance criteria,
verification, assumptions, and stop conditions. After success, continue the
normal diff, independent checks, review, and apply lifecycle.

## Stop Conditions

Stop rather than bypassing a condition when:

- the source is not a Git worktree, has no `HEAD` commit, or has unmerged
  paths;
- the task needs ignored artifacts not safely selected by `.dshinclude`, or
  its manifest contains credentials, secrets, unrelated content, or excessive
  scope;
- the Runner reports a failure whose processes are still live, state cannot be
  explained, or temporary Git index was changed;
- failed-Runner inspection returns any session phase other than `prepared`,
  including `review_ready` or `applied`;
- `reopen` detects that a reviewed worktree drifted after patch generation;
- the review patch is empty but DSH claims code changes;
- source changes make `apply --check` fail;
- the patch is applied but automatic worktree cleanup fails.

The source may have unrelated staged or unstaged changes. The patch application
checks only DSH's affected content and preserves the source index. After
application, ordinary Git status shows the resulting combined worktree state;
it does not retain author attribution.
