# DSH Web Bridge Protocol

Use this protocol for the default `$dsh-agent` workflow. Codex talks only to
the loopback DSH Web RPC surface. DSH owns its sessions and executes every
`dsh-task-worktree` command; Codex never imports or invokes the plugin.

## Prerequisites

- Start DSH Web separately, normally with `dsh --profile web --no-open`.
- Install `dsh-task-worktree` in the `web` profile.
- Keep the service on loopback. The bridge accepts only `http://127.0.0.1`,
  `http://localhost`, or `http://[::1]` URLs.
- The default URL is `http://127.0.0.1:3080`; override it with `--web-url` or
  `DSH_WEB_URL`.

The bridge does not start or stop DSH Web. This avoids competing with an
already-open UI and keeps ownership of the long-lived service explicit.

## Public commands

Prepare a permanent plugin-owned worktree and two DSH sessions:

```text
node scripts/dsh_web.mjs prepare \
  --cwd <absolute-codex-host-cwd> \
  --name <safe-task-name> \
  [--web-url http://127.0.0.1:3080]
```

`prepare` creates a controller DSH session over the source repository and sends
the exact DSH slash command `/worktree create <name>`. DSH's command registry
invokes `dsh-task-worktree`. After validating the created checkout against Git,
the bridge creates a worker DSH session whose cwd is the corresponding path in
that worktree. The resulting state is stored beneath
`<repo>/.dsh-worktrees/codex-bridge/` and includes `statePath` in the output.

Run the first implementation turn or a later correction in the same worker
session:

```text
node scripts/dsh_web.mjs run \
  --state <absolute-statePath> \
  --prompt-file <absolute-brief-path> \
  [--timeout-ms <milliseconds>]
```

Inspect local Git state or ask DSH's plugin for status:

```text
node scripts/dsh_web.mjs inspect --state <absolute-statePath>
node scripts/dsh_web.mjs status --state <absolute-statePath>
```

After explicit user approval, ask DSH to bring the worktree back or remove it:

```text
node scripts/dsh_web.mjs bring-back --state <absolute-statePath> [--message <text>]
node scripts/dsh_web.mjs remove --state <absolute-statePath> [--force]
```

These are DSH slash commands sent through the controller session. They are not
direct Codex calls into the plugin. `bring-back` may create a worktree commit
and merge it into the source branch according to the plugin's rules.

## Session and task behavior

The state records one controller session and one worker session:

```json
{
  "controllerSessionId": "codex-bridge-controller-...",
  "workerSessionId": "codex-bridge-worker-...",
  "worktreeName": "codex/task-name",
  "worktreePath": ".../.dsh-worktrees/worktree/codex/task-name",
  "workerCwd": "...",
  "branch": "codex/task-name",
  "baseCommit": "..."
}
```

Every `run` sends the fixed safety policy plus the complete delegation brief to
the same `workerSessionId`. The bridge polls `session.history` until it observes
a new `turn/end`, extracts the final assistant text, and records the last event
sequence. A correction therefore retains both the same worktree and DSH's
conversation context.

The fixed policy forbids the DSH model from committing, staging, publishing,
handling credentials, changing DSH configuration, or writing outside the
worker cwd. Approved `bring-back` is a separate DSH command action and is not
authorized by a successful model turn.

## Validation and failure rules

Before accepting `prepare`, the bridge verifies:

- the requested name is a safe Git ref path;
- the source worktree is clean, so its committed HEAD is the complete baseline;
- DSH confirmed `/worktree create`;
- the expected default plugin checkout exists under
  `.dsh-worktrees/worktree/<name>`;
- Git registers the checkout with the requested branch;
- its HEAD equals the source HEAD used for preparation;
- the checkout starts clean; and
- the worker cwd preserves the Codex host subdirectory boundary.

The current integration assumes the plugin's default `.dsh-worktrees`
directory. A different plugin `dirName` must be supplied consistently with
`--worktree-dir-name`.

Stop on RPC, validation, model-turn, timeout, or Git failures. Never retry
automatically, create a second worktree name, broaden the host cwd, or switch to
headless silently. Preserve the state and inspect it before an approved
recovery.

The result envelope uses `transport: "web"`. `run` succeeds only when the new
turn ends with `reason.kind === "completed"`; all other reasons return a failed
envelope. With `--prompt-file`, the same final envelope is written beside the
brief as `<prompt-file>.result.json`.
