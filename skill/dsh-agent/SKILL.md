---
name: dsh-agent
description: Delegate bounded coding tasks to a persistent DeepSeek Harness Web session inside a dsh-task-worktree checkout while Codex plans, reviews, verifies, and controls approved bring-back. Use when Codex should orchestrate DSH through its Web profile without calling the DSH plugin directly. Use the legacy headless transport only when explicitly requested.
---

# DSH Agent

Use DSH Web as the coding worker and `dsh-task-worktree` as DSH's permanent
workspace manager. Codex compiles the task, calls only the DSH Web RPC bridge,
reviews the resulting Git changes, and owns acceptance. DSH executes every
plugin command and all coding work.

## Core boundaries

- Never import, execute, or emulate `dsh-task-worktree` from Codex. Run only
  `scripts/dsh_web.mjs`; it sends commands and prompts to DSH Web.
- Use the permanent worktree returned by DSH. Never combine this mode with the
  legacy `scripts/dsh_worktree.mjs` coordinator or create nested worktrees.
- Keep DSH Web on loopback and use the displayed local URL. Never connect this
  bridge to a LAN or remote DSH Web endpoint.
- Send implementation and correction turns to the recorded worker session id.
  The controller session exists only for DSH worktree commands.
- Independently inspect Git changes and run checks. DSH's final answer is not
  proof of acceptance.
- Run DSH `bring-back` or `remove` only after a separate explicit user approval.
  Never replace plugin lifecycle commands with direct Git commit, merge, clean,
  reset, or worktree removal.

## Required setup

DSH Web must already be running, normally:

```text
dsh --profile web --no-open
```

The web profile must contain `dsh-task-worktree`. The bridge defaults to
`http://127.0.0.1:3080`; use `DSH_WEB_URL` or `--web-url` when DSH displays a
different loopback port.

If DSH Web is unavailable or the plugin command is unknown, stop and report the
exact prerequisite. Do not install plugins, start another profile, change DSH
settings, or fall back to headless without explicit authorization.

## Load references progressively

| Condition                                                                    | Required reference                                                           | Purpose                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Every Web invocation                                                         | `references/protocol.md`                                                     | RPC, CLI, state, validation, and failure contract              |
| Every code-changing task                                                     | `references/worktree-review.md`                                              | Prepare, review, correction, bring-back, and removal lifecycle |
| Project rules, specifications, OpenSpec, external context, or Skill guidance | `references/delegation-prompt.md`                                            | Compile a self-contained brief                                 |
| User explicitly requests the old one-shot mode                               | `references/headless-protocol.md` and `references/legacy-worktree-review.md` | Legacy compatibility only                                      |

Read each triggered reference completely before invoking its script. Do not
reconstruct commands from memory.

## Inspect and prepare

Before preparation, inspect source `git status` and relevant diffs without
modifying or staging them. Use the Codex session's authorized directory as
`hostCwd`; keep the narrower modification scope in the task brief.

The source worktree must be clean. A remote push is not required, but the full
baseline must exist in local `HEAD`; this mode does not copy uncommitted source
changes into the DSH worktree.

Choose one safe, descriptive task name such as `codex/fix-session-timeout` and
disclose that preparation will ask DSH to create a permanent branch and
worktree. Then run:

```text
node /path/to/dsh-agent/scripts/dsh_web.mjs prepare \
  --cwd <absolute-hostCwd> \
  --name <task-name> \
  [--web-url <loopback-url>]
```

Record the returned `statePath`, `worktreePath`, `workerCwd`, `branch`,
`baseCommit`, `controllerSessionId`, and `workerSessionId`. The bridge sends
`/worktree create <task-name>` through the DSH controller session; Codex does
not call the plugin.

Stop if the command or any validation fails. Do not guess a path, reuse an
unvalidated checkout, or create another name automatically.

## Compile the delegation brief

Use this base contract:

```markdown
# DSH Delegation Brief v1

## Objective

<One bounded coding objective.>

## Change Scope

Host access boundary: <hostCwd>
DSH worktree root: <worktreePath>
DSH worker cwd: <workerCwd>
May modify: <narrow paths inside workerCwd>
Must not modify: <unrelated or protected paths>

## Acceptance Criteria

- <Observable result.>

## Verification

- <Exact relevant checks.>

## Completion Report

Report files changed, checks run and their results, and unresolved limitations.
```

Compile relevant non-sensitive project instructions and Skill guidance when
required by `references/delegation-prompt.md`. Never ask DSH to discover or
invoke a Codex Skill.

## Authorize external data transfer

Before the first coding `run`, obtain explicit task-scoped authorization to
send the delegation brief and task-required private project files available
under `workerCwd` to DSH's configured model provider. Disclose the objective,
paths, data categories, exclusions, and that authorization covers at most two
same-scope corrections.

Do not send credentials, secrets, unrelated files, ignored local artifacts, or
data outside the Codex host boundary. Reauthorize before widening the objective,
cwd, modification scope, or data categories. Worktree preparation itself does
not authorize model data transfer, and transfer authorization does not approve
bring-back.

Use Brief Review when the user requests a preview or when scope, acceptance,
architecture, migration, security, dependencies, or compiled rules are
materially ambiguous. A precise local change may proceed after transfer
authorization without a separate preview.

## Execute and correct

Write the brief to a private absolute prompt file outside `workerCwd` and run:

```text
node /path/to/dsh-agent/scripts/dsh_web.mjs run \
  --state <statePath> \
  --prompt-file <absolute-brief-path>
```

Use `--timeout-ms 3600000` only when the user explicitly classifies the
delegated task as long-running. Wait for the final JSON envelope; do not inspect
or mutate the worktree while the DSH turn is active.

After success, follow `references/worktree-review.md`: inspect the complete
candidate, run independent checks, and identify concrete defects. For an
in-scope defect, write a complete correction brief and invoke the same `run`
command with the same state. The bridge reuses `workerSessionId`, so DSH retains
both conversation and filesystem context.

Allow at most two correction turns. Stop for a third correction, a repeated
hard failure, a material user decision, or required scope expansion.

## Accept and bring back

Present only a passing candidate. Report actual changed and untracked files,
independent checks, DSH turn status, worktree path, and branch. Explain that
the plugin's bring-back may commit the worktree and merge it into the source
branch.

After a separate explicit approval, run exactly:

```text
node /path/to/dsh-agent/scripts/dsh_web.mjs bring-back --state <statePath>
```

If DSH rejects the operation because the source is dirty or another lifecycle
guard fails, stop. Do not bypass it with direct Git commands. If the user wants
to abandon the task, obtain separate approval before `remove`; `--force`
requires explicit approval to discard dirty worktree changes.

At handoff, report whether the permanent DSH worktree remains prepared, was
brought back, or was removed, and include the retained state path.

## Install

Install this directory as `.codex/skills/dsh-agent/` in a project or in the
personal Codex skills directory. Keep `scripts/`, `references/`, and `agents/`
together. `dsh-worker` is the optional compatibility alias installed beside it.
