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
index baseline. The source worktree remains untouched while Qoder works.

```sh
node /path/to/qoder-agent/scripts/qoder_worktree.mjs prepare \
  --cwd /absolute/path/to/project
```

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
--check` first and leaves the original index untouched. A conflict or any
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
`--timeout-ms`. Their environment equivalents are `QODERCLI_PATH`,
`QODER_MODEL`, and `QODER_TIMEOUT_MS`; CLI values take precedence. The Runner
always uses Qoder `permission-mode auto`, JSON output, and no session
persistence. Do not pass credentials, permission overrides, tool filters, or
system-prompt overrides.

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
5. Wait for explicit approval before applying. On approval, run `apply`; if
   its preflight detects a conflict, report it and leave the source untouched.
6. If the result reports permission denial, authentication failure, timeout,
   non-zero exit, output-limit termination, or another failure, stop and report
   the envelope to the main Codex session. Do not retry automatically. Keep the
   temporary worktree until the user explicitly asks to discard it.
7. After a successful run, issue at most two explicit correction tasks. Generate
   a new review session for every correction task; never loop without an
   explicit new task.

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
