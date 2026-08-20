# DSH Web Worktree Review Lifecycle

Use this reference for every code-changing Web workflow. The permanent
worktree and its lifecycle belong to DSH and `dsh-task-worktree`; Codex owns
planning, independent review, acceptance, and the approval boundary.

## Prepare

1. Inspect the source repository status without changing it. Stop if it is
   dirty; this mode deliberately does not carry uncommitted source changes.
2. Choose one disclosed task name such as `codex/fix-login-timeout`.
3. Run `dsh_web.mjs prepare` with the Codex session's authorized host cwd.
4. Record `statePath`, `worktreePath`, `workerCwd`, branch, base commit, and both
   DSH session ids from the envelope.
5. Stop if DSH Web is unavailable, the plugin command is unknown, validation
   fails, or the new worktree is not clean.

Do not also call the legacy `dsh_worktree.mjs`; nested ownership by two
worktree coordinators is unsupported.

Preparation sends a slash command to DSH but no coding brief to the model. It
creates a permanent checkout, branch, plugin manifest record, and DSH sessions.
Disclose this local mutation before preparation when the surrounding user
request did not already authorize creating a task worktree.

## Execute and review

After any required Brief Review and external-data authorization, write the
complete brief outside `workerCwd` and run `dsh_web.mjs run --state ...
--prompt-file ...`.

After a successful turn:

1. Run `dsh_web.mjs inspect --state ...`.
2. Inspect `git -C <worktreePath> status --short`.
3. Review tracked changes with `git -C <worktreePath> diff --binary
   <baseCommit>` and inspect every untracked file separately.
4. Run relevant checks independently in `workerCwd`.
5. Treat DSH's completion report as evidence, never acceptance.

The plugin worktree starts clean, so all worktree changes after preparation are
candidate changes. Source-worktree dirt is not copied by this workflow and must
not be confused with the candidate.

## Correction loop

For a concrete, in-scope defect, send a self-contained correction brief through
the same state file. The bridge routes it to the same `workerSessionId`, so DSH
retains its conversation and filesystem context.

Allow at most two correction turns under the original objective, cwd boundary,
data categories, and modification scope. Reauthorize before widening any of
them. Stop for a material product decision, repeated hard failure, ambiguous
acceptance, or a third correction.

## Bring back or remove

Present the passing candidate with changed files, independent checks, branch,
base commit, and worktree path. Explain that DSH's `bring-back` command may
commit the worktree and merge it into the source branch.

Only after explicit user approval run:

```text
node scripts/dsh_web.mjs bring-back --state <statePath>
```

Do not treat approval of the brief, data transfer, DSH execution, or review as
approval to bring back. Let the plugin reject a dirty source workspace or other
unsafe state; do not bypass its checks with direct Git commands.

If the user abandons the candidate, ask separately before running remove.
`--force` requires explicit approval that mentions discarding dirty worktree
changes. Never prune, remove, commit, merge, or rewrite the worktree through
direct Codex Git commands as a substitute for the DSH plugin lifecycle.

At handoff, report whether the plugin worktree remains prepared, was brought
back, or was removed, together with the retained `statePath`.
