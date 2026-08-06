---
name: qoder-agent
description: Delegate bounded coding tasks to a locally installed Qoder CLI through a one-shot, non-interactive Runner. Use when Codex needs Qoder to edit or test files inside an explicitly trusted project directory while Codex retains responsibility for scope, safety, diff review, and acceptance.
---

# Qoder Agent

Use the bundled Runner to delegate one narrowly scoped coding task to the
locally installed Qoder CLI. Keep the task small enough to review as one diff
and provide the absolute project directory explicitly.

## Invoke the Runner

Run:

```sh
node /path/to/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/project \
  --prompt "Implement the bounded task and run the relevant tests. Do not commit or push."
```

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

1. Record the task scope, `git status`, and the relevant diff before invoking
   Qoder. Preserve unrelated user changes.
2. Invoke the Runner with an absolute `cwd` and a bounded prompt that names the
   requested files, behavior, and checks. State that Qoder must not commit,
   push, publish, reset, clean, or modify files outside `cwd`.
3. Let Qoder work only under the Runner's fixed safety policy and `auto`
   permissions. Do not change modes if an action is denied.
4. Inspect the actual `git diff`, `git status`, and test output independently;
   do not treat Qoder's self-reported summary as acceptance evidence.
5. If the result reports permission denial, authentication failure, timeout,
   non-zero exit, output-limit termination, or another failure, stop and report
   the envelope to the main Codex session. Do not retry automatically.
6. After a successful run, issue at most two explicit correction tasks. Review
   the resulting diff and tests after each correction, and never loop without
   an explicit new task.

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
