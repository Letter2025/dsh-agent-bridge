---
name: qoder-agent
description: Delegate bounded coding tasks to a locally installed Qoder CLI through a one-shot, non-interactive Runner. Use when Codex needs Qoder to edit or test files inside an explicitly trusted Git project while Codex retains responsibility for isolated worktrees, exact Qoder-only diff review, safe application, and acceptance.
---

# Qoder Agent

Use the bundled Runner to delegate one narrowly scoped coding task to the
locally installed Qoder CLI. Keep the task small enough to review as one diff
and provide the absolute project directory explicitly.

## Host Execution Requirement

When invoking the Runner or the bundled worktree coordinator from Codex, run
that exact command with host access (`sandbox_permissions:
"require_escalated"`) after obtaining the user's approval. Qoder CLI needs
access to its local authentication state and to the host network, including any
loopback proxy; Git worktree management needs access to the repository's Git
metadata. A restricted command sandbox can isolate both; Qoder may then fail
before work begins with a network error even when the desktop app is signed in
and its proxy is healthy.

Keep the escalation narrow: it applies only to a single `node
.../run_qoder.mjs` or `node .../qoder_worktree.mjs` invocation and needs a
justification for its host authentication, network, or Git metadata access. Do
not request a reusable broad approval for arbitrary Node or shell commands.
Host execution does not relax the Runner's fixed safety policy, absolute `cwd`
requirement, or Qoder `permission-mode auto`.

## Isolated Worktree Review (Default)

For a code-changing task in a Git worktree, use the bundled coordinator before
the Runner. It creates a temporary detached worktree, mirrors the source's
tracked and non-ignored untracked files into it, and records that state as an
index baseline. Ignored dependencies such as `node_modules` are not copied,
linked, or installed. The source worktree remains untouched while Qoder works.

```sh
node /path/to/qoder-agent/scripts/qoder_worktree.mjs prepare \
  --cwd /absolute/path/to/project
```

When starting a fresh retry after a failed session, pass the failed session's
state file explicitly:

```sh
node /path/to/qoder-agent/scripts/qoder_worktree.mjs prepare \
  --cwd /absolute/path/to/project \
  --retry-of /absolute/path/from-previous-session/session.json
```

The retry session must belong to the same source worktree. If the retry later
applies successfully, the coordinator disposes the new session and all linked
predecessor sessions. If the retry fails, the entire linked chain remains
available for diagnosis.

Read the JSON response and invoke the Runner with `qoderCwd`, not the source
directory. After Qoder succeeds, generate and inspect the exact Qoder-only
patch:

```sh
node /path/to/qoder-agent/scripts/qoder_worktree.mjs diff \
  --state /absolute/path/from-prepare/session.json
```

Run relevant checks in the temporary worktree. Present the actual changed
files, patch, and check results for review. Do not apply the patch or remove
the temporary worktree until the user explicitly asks to apply the reviewed
changes. Then use the coordinator's `apply` operation; it runs `git apply
--check` first, leaves the original index untouched, and automatically removes
the temporary worktree after a successful application. A conflict or any
other failure is a stop condition, never a cue to force or retry.

The coordinator requires a Git worktree with a `HEAD` commit and no unmerged
paths. Ignored files are deliberately not mirrored. For non-Git directories,
unmerged repositories, or tasks that require ignored local artifacts, explain
the limitation and obtain an explicit alternate workflow; do not silently run
Qoder in the source directory. Read
[references/worktree-review.md](references/worktree-review.md) before using
this workflow.

## Invoke the Runner

Run:

```sh
node /path/to/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/project \
  --prompt "Implement the bounded task and run the relevant tests. Do not commit or push."
```

In Codex, submit this command with `sandbox_permissions:
"require_escalated"`. Never use an escalation to add Qoder permission
overrides, tool filters, or system-prompt overrides.

Optional configuration flags are `--qodercli-path`, `--model`, and
`--timeout-ms`, and `--max-model-request-retries`. Their environment
equivalents are `QODERCLI_PATH`, `QODER_MODEL`, `QODER_TIMEOUT_MS`, and
`QODER_MAX_MODEL_REQUEST_RETRIES`; CLI values take precedence. The Runner
defaults model request retries to three and always uses Qoder `permission-mode
auto`, JSON output, and no session persistence. Do not pass credentials,
permission overrides, tool filters, or system-prompt overrides.

For a portable installation, make `qodercli` available on `PATH` for the
Codex process, or configure an absolute `QODERCLI_PATH`. The Runner never
guesses a user-home installation path.

## Collaborate Safely

1. Record the task scope, source `git status`, and relevant source diff. Do
   not modify or stage source changes to prepare Qoder's worktree.
2. Create the isolated worktree and invoke the Runner with the returned
   `qoderCwd`. Use a bounded prompt that names requested files, behavior, and
   checks. State that Qoder must not commit, push, publish, stage, stash,
   reset, clean, or modify files outside `cwd`.
3. Let Qoder work only under the Runner's fixed safety policy and `auto`
   permissions. Do not change modes if an action is denied.
4. Generate the coordinator's review patch, inspect that exact patch and the
   temporary-worktree test output independently, and present them to the user.
   Do not treat Qoder's self-reported summary as acceptance evidence.
5. Wait for explicit approval before applying. On approval, run `apply`; it
   automatically disposes the temporary worktree after a successful patch
   application. If its preflight detects a conflict, report it and leave the
   source and temporary worktree untouched.
6. If the result reports permission denial, authentication failure, timeout,
   non-zero exit, output-limit termination, cleanup failure, or another
   failure, stop and report the envelope to the main Codex session. Do not
   retry automatically. Keep the temporary worktree until the user explicitly
   asks to discard it. If a new attempt is approved, create its worktree with
   `--retry-of <statePath>` so a later successful apply can clean the linked
   chain. For a patch that was applied but whose cleanup failed, retry
   `dispose` directly. Apply only the narrow model-queue recovery below.
7. After a successful run, issue at most two explicit correction tasks. Generate
   a new review session for every correction task; never loop without an
   explicit new task.

## Recover a Model Queue Failure

Treat only `error.code: model_queue_exhausted` with `retryable: true` as a
recoverable queue failure. Do not generalize from other gateway, provider, or
queue text.

1. Run `qoder_worktree.mjs inspect --state <statePath>`. Do not run `diff`,
   `apply`, or `dispose`; `diff` stages files and advances the session.
2. Report the candidate files, `indexModified`, and retained worktree. If
   `indexModified` is true, stop because Qoder violated the index boundary.
3. Obtain explicit approval for one recovery continuation. Never retry
   automatically or more than once.
4. Re-run the Runner in the same `qoderCwd` and same prepared worktree. Restate
   the original task and acceptance criteria, and instruct Qoder to inspect and
   repair existing uncommitted changes rather than restart from scratch.
5. After success, continue the original `diff`, independent checks, review, and
   apply flow. Do not create a new review session for queue recovery; doing so
   could turn the interrupted edits into an excluded baseline.

Use this recovery prompt shape:

```text
Continue the interrupted bounded task from the existing uncommitted changes in
this worktree. Inspect the current diff before editing and do not restart from
scratch.

Original task and acceptance criteria:
<repeat the original bounded task and checks>

Repair incomplete or invalid edits, complete the task, and run the relevant
checks. Do not commit, stage, stash, reset, clean, or modify Git worktree
configuration.
```

The Runner returns one JSON envelope on stdout and short diagnostics on
stderr. Read [references/protocol.md](references/protocol.md) for the exact
fields, limits, error codes, and process lifecycle.

## Install the Skill

For a project-local Skill, copy this directory to the project's
`.codex/skills/qoder-agent/` directory. For a personal Skill, copy it to
`~/.codex/skills/qoder-agent/` or the configured Codex skills directory. Keep
`scripts/run_qoder.mjs` executable and retain `references/` and `agents/`.

The repository also supports direct use from `skill/qoder-agent/` during local
development; no package build is required for the Runner.
