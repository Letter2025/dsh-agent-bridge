---
name: qoder-agent
description: Delegate bounded coding tasks to a locally installed Qoder CLI through a context-aware, one-shot Runner. Use when Codex needs Qoder to edit or test files inside an explicitly trusted Git project while Codex compiles relevant project context and installed Skill rules into a self-contained task brief and retains responsibility for isolated worktrees, exact Qoder-only diff review, safe application, and acceptance.
---

# Qoder Agent

Use the bundled Runner to delegate one narrowly scoped coding task to the
locally installed Qoder CLI. Keep the task small enough to review as one diff
and use the narrowest absolute working directory that contains every expected
change. Treat Codex as the context compiler and Qoder as the coding executor:
Qoder does not need access to Codex Skills or implicit Codex context.

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
  --cwd /absolute/path/to/task-scope
```

Create a fresh retry worktree only when the existing session cannot be safely
continued or the user explicitly requests a clean restart. Link that new
worktree to the retained predecessor:

```sh
node /path/to/qoder-agent/scripts/qoder_worktree.mjs prepare \
  --cwd /absolute/path/to/project \
  --retry-of /absolute/path/from-previous-session/session.json
```

The retry session must belong to the same source worktree. Do not use
`--retry-of` for an ordinary review correction or a trustworthy Runner failure;
both continue in the existing worktree. If a fresh retry later applies
successfully, the coordinator disposes it and all linked predecessors. If it
fails, the entire linked chain remains available for diagnosis.

Read the JSON response and invoke the Runner with `qoderCwd`, not the source
directory. Before invoking it, compile the delegation brief described below.
After Qoder succeeds, generate and inspect the exact Qoder-only patch:

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

If independent review rejects a concrete in-scope candidate, reopen that exact
session before the bounded correction run:

```sh
node /path/to/qoder-agent/scripts/qoder_worktree.mjs reopen \
  --state /absolute/path/from-prepare/session.json
```

`reopen` archives the rejected patch, restores only the temporary Git index to
the original baseline, and keeps every working-tree change for Qoder to repair.
It fails if the reviewed state drifted after patch generation. Use the returned
same `qoderCwd`; never prepare a new worktree for this correction.

## Build the Delegation Brief

Compile every task into this short base contract without loading another
reference:

```markdown
# Qoder Delegation Brief v1

## Objective

<One bounded coding objective.>

## Change Scope

May modify: <narrow paths inside qoderCwd>
Must not modify: <unrelated or protected paths>

## Acceptance Criteria

- <Observable outcome.>

## Verification

- <Exact relevant check, or explain why none applies.>

## Completion Report

Report files changed, checks run and their results, and unresolved limitations.
```

Do not widen `qoderCwd` merely to expose instructions or specifications. If
the task genuinely spans multiple targets, use their narrowest common ancestor.
Reference a context file only when it exists inside `qoderCwd`; otherwise have
Codex compile its relevant non-sensitive guidance into the brief.

Read [references/delegation-prompt.md](references/delegation-prompt.md)
completely only when the task needs a context extension: applicable project
instructions or specifications, an OpenSpec change, portable guidance from
another Codex Skill, context outside `qoderCwd`, or material rule conflict.
Add only the relevant optional sections. Never tell Qoder to use a Codex Skill
or assume that Skill is installed in Qoder.

## Choose Brief Review Policy

Use a three-state pre-execution policy. This is also called Spec mode; it is a
brief approval gate, not OpenSpec generation.

- `required`: Use when the user explicitly requests Spec mode or a brief
  preview. Show the preview and wait for explicit approval before invoking
  Qoder.
- `off`: Use when the user explicitly asks to skip the preview. This never
  skips necessary clarification, host-execution approval, or final patch-apply
  approval.
- `auto`: Use by default. Show the preview when delegation risk is elevated by
  ambiguous acceptance, multiple modules or a broad working directory,
  OpenSpec or other project specifications, compiled rules from another Skill,
  material rule conflicts or assumptions, public API or architecture changes,
  migrations, security-sensitive behavior, or dependency/build/deployment
  changes. Prefer no interruption for precise, local, easily reversible tasks.

When review is required, show a concise preview containing the objective,
context and compiled rules when present, change scope, acceptance criteria,
verification, and material assumptions. Do not invoke Qoder until the user
approves it. Re-present the preview after any material change to those fields.
Brief approval authorizes only the Qoder run; it never authorizes applying the
resulting patch.

## Write the Brief Safely

Write the complete approved or auto-accepted brief to a private temporary file
outside `qoderCwd`. For a worktree session, place `delegation-brief.md` beside
the returned `statePath` so successful session cleanup removes it. Use a
non-shell file-writing tool and restrict access to the current user when
possible.

Never interpolate brief content into a shell command. Do not use `echo`,
`printf`, shell redirection, command substitution, or a heredoc to create or
pass it. The brief may contain quotes, backticks, `$()`, and arbitrary
multi-line text. Do not include credentials or secrets.

## Invoke the Runner

Run:

```sh
node /path/to/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/task-scope \
  --prompt-file /absolute/path/to/delegation-brief.md
```

In Codex, submit this command with `sandbox_permissions:
"require_escalated"`. Never use an escalation to add Qoder permission
overrides, tool filters, or system-prompt overrides.

The user's original bounded task authorizes in-scope correction runs described
below; do not ask for separate conversational permission merely because a new
Qoder session is needed. Host-execution approval remains a separate sandbox
requirement: submit the exact escalated command when needed and let the command
approval mechanism handle it.

The final envelope is emitted after Qoder exits and, with `--prompt-file`, is
first saved as `<prompt-file>.result.json`. When the terminal tool supports a
configurable yield, request at most 30000 ms for the initial Runner command. If
it yields a live command session without an exit code, continue that same
session with an empty stdin write and request `yield_time_ms: 180000`. Repeat
only after that wait returns without an exit code; do not poll more frequently.
The three-minute value is a maximum wait, not a fixed delay: process output or
exit returns control early. If the terminal tool does not expose or rejects
these yield values, omit them and use its defaults rather than treating that as
a Runner failure.

Until an exit code is available, empty stdout and worktree inspections are
provisional. Allow the configured timeout plus termination grace. After both
processes end, use the command envelope or the saved result. If neither exists,
report the lost session, retain the worktree, and do not retry automatically.
See [references/protocol.md](references/protocol.md) for the exact persistence
and lifecycle contract.

Optional configuration flags are `--qodercli-path`, `--model`, and
`--timeout-ms`, and `--max-model-request-retries`. Their environment
equivalents are `QODERCLI_PATH`, `QODER_MODEL`, `QODER_TIMEOUT_MS`, and
`QODER_MAX_MODEL_REQUEST_RETRIES`; CLI values take precedence. The Runner
defaults to a 15-minute timeout and allows at most one hour. It defaults model
request retries to three and always uses Qoder `permission-mode auto`, JSON
output, and no session persistence. Do not pass credentials, permission
overrides, tool filters, or system-prompt overrides.

The inline `--prompt` option exists only for compatibility. Never use it from
this Skill for model-generated or multi-line task content.

For a portable installation, make `qodercli` available on `PATH` for the
Codex process, or configure an absolute `QODERCLI_PATH`. The Runner never
guesses a user-home installation path.

## Collaborate Safely

1. Record the narrowest task `cwd`, source `git status`, and relevant source
   diff. Do not modify or stage source changes to prepare Qoder's worktree.
2. Create the isolated worktree, compile the brief against the returned
   `qoderCwd`, apply the brief-review policy, write the approved or
   auto-accepted brief safely, and invoke the Runner with `--prompt-file`.
3. Let Qoder work only under the Runner's fixed safety policy and `auto`
   permissions. Do not change modes if an action is denied.
4. Generate the coordinator's review patch, inspect that exact patch, and run
   the relevant checks independently. Do not treat Qoder's self-reported
   summary as acceptance evidence. If review finds a concrete in-scope defect,
   run the bounded correction cycle below before presenting a candidate.
5. Present only a candidate that passes independent review, then wait for
   explicit approval before applying. On approval, run `apply`; it
   automatically disposes the temporary worktree after a successful patch
   application. If its preflight detects a conflict, report it and leave the
   source and temporary worktree untouched.
6. If the result reports permission denial, authentication failure, timeout,
   interruption, non-zero exit, output-limit termination, a lost command
   channel, or another execution failure, stop and report the envelope. Do not
   retry automatically. After both Runner and Qoder have ended, inspect the
   existing session. If it remains `prepared`, its index is unchanged, its
   changes are explainable and in scope, and the original task still applies,
   an explicitly approved recovery must reuse that same `statePath` and
   `qoderCwd`. Follow the failed-Runner recovery below. Prepare a linked fresh
   retry only when reuse is unsafe or the user requests a clean restart. For a
   patch that was applied but whose cleanup failed, retry `dispose` directly.
7. After a successful Runner execution whose candidate fails independent
   review, automatically issue at most two correction tasks when every finding
   is concrete, verifiable, and inside the original objective, scope, and
   acceptance criteria. The original task authorization covers these runs; an
   "explicit correction task" means a new bounded brief, not new conversational
   approval. Preserve the full original task and add the review findings.
   Invoke `reopen --state <statePath>`, then rerun Qoder in its returned same
   `qoderCwd` so the correction inherits the complete rejected candidate.
   Store each correction brief under a distinct filename beside the session
   state so its `.result.json` does not overwrite prior evidence. Reapply Brief
   Review: under `auto`, a precise in-scope correction does not itself require a
   preview; `required` still does. Rerun independent review and count no more
   than two correction runs after the initial attempt. Stop and retain the
   session if `reopen` detects drift, the correction needs a material decision
   or scope expansion, exhausts the limit, or still fails. Never apply an
   unaccepted candidate.

## Recover a Failed Runner

Reuse trustworthy partial work after a Runner failure; do not replace it with a
fresh baseline merely because the Runner did not succeed. Recovery never
broadens permissions or scope and still requires explicit approval. Treat only
`error.code: model_queue_exhausted` with `retryable: true` as the specific model
queue case, and allow at most one recovery for it. Do not generalize from other
gateway, provider, or queue text.

1. Run `qoder_worktree.mjs inspect --state <statePath>`. Do not run `diff`,
   `apply`, or `dispose`; `diff` stages files and advances the session.
2. Confirm the original Runner and Qoder processes have ended. Report the
   phase, candidate files, `indexModified`, and retained worktree. Continue only
   when the phase is `prepared`, `indexModified` is false, all changes are
   explainable and in scope, and the original task and baseline remain valid.
   Otherwise stop and retain the session.
3. Obtain explicit approval before continuing any failed execution. Never
   retry automatically. Resolve authentication, executable, permission, or
   other external prerequisites before reissuing the Runner, and stop when the
   same hard failure repeats.
4. Re-run the Runner in the same `qoderCwd` and same prepared worktree. Reissue
   the original delegation brief with an objective that instructs Qoder to
   inspect and repair existing uncommitted changes rather than restart from
   scratch. Preserve its required context, compiled rules, scope, acceptance
   criteria, and checks. Use a distinct recovery brief filename so prior Runner
   evidence remains available.
5. After success, continue the original `diff`, independent checks, review, and
   apply flow. Do not create a new worktree for a trustworthy recovery; doing so
   would discard the interrupted edits.

Use this recovery objective inside the reissued delegation brief:

```text
Continue the interrupted bounded task from the existing uncommitted changes in
this worktree. Inspect the current diff before editing and do not restart from
scratch.

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
