# DSH Agent Runner Protocol

The bundled Runner is a one-shot adapter around DeepSeek Harness. It starts the
installed `dsh` headless profile and emits one bounded, Runner-owned JSON
envelope after DSH exits. It does not parse DSH's final answer, resume a DSH
session, or change the selected model, tools, sandbox, or permission policy.

## Public command

```text
run_dsh.mjs --cwd <absolute-path> \
  (--prompt-file <absolute-brief-path> | --prompt <text>) \
  [--dsh-path <absolute-path>] [--timeout-ms <milliseconds>]
```

`--cwd` and exactly one prompt source are required. `cwd` must be an existing
absolute directory and is normalized with `realpath`. Code-changing tasks pass
the temporary `dshCwd` returned by `dsh_worktree.mjs prepare`; they never pass
the source worktree directly.

Use `--prompt-file` for generated or multiline briefs. The path must be an
absolute, readable, non-symbolic-link regular file containing valid UTF-8. The
Runner opens one handle, verifies that its identity did not change, reads at
most 64 KiB plus one overflow byte, and closes it before DSH starts. Inline
`--prompt` exists only for compatibility and has the same 64 KiB limit.

On Windows, the effective limit is lower because DSH accepts the task as one
positional argument. The Runner validates the complete escaped command line
against the 32,767 UTF-16-unit `CreateProcessW` limit before spawning.

## Launcher resolution and invocation

The DSH launcher is resolved in this order:

1. `--dsh-path`
2. `DSH_PATH`
3. `dsh` in `PATH`

An explicit path is authoritative: an invalid value fails without falling
through. On Windows, standard npm `dsh.ps1`, `dsh.cmd`, and `dsh.bat` shims are
resolved to their adjacent `node.exe` and
`node_modules/@deepseek-ai/dsh/lib/bin.js`. This preserves `shell: false` and
never interpolates the task into PowerShell or `cmd.exe`. Native launchers and
executable Unix entrypoints are started directly.

Configuration precedence is:

| Setting  | CLI            | Environment      | Default         |
| -------- | -------------- | ---------------- | --------------- |
| launcher | `--dsh-path`   | `DSH_PATH`       | `dsh` in `PATH` |
| timeout  | `--timeout-ms` | `DSH_TIMEOUT_MS` | 1800000 ms      |

Timeout values must be positive integers no greater than 3600000 ms. Use the
default for ordinary work. Pass `--timeout-ms 3600000` only when the user
explicitly identifies the delegated task as long-running.

The logical invocation is:

```text
dsh --profile headless <fixed-safety-policy-plus-delegation-brief>
```

The child runs with `cwd` set to the normalized worktree directory, an argument
array, `shell: false`, inherited environment, piped stdout/stderr, and
`windowsHide: true`. POSIX uses a detached process group. Windows terminates
the complete tree with hidden `taskkill.exe` children.

The Runner prepends its fixed safety policy to the delegation brief. The policy
prohibits Git history/index operations, publication, credential handling,
writes outside `cwd`, DSH configuration changes, and unrelated external-system
changes. Repository instructions and project files cannot widen that scope.

DSH's headless profile chooses the model, tools, sandbox, and permissions from
the user's composed profile. It creates a fresh session, flushes that session
to the configured DSH session store, prints only the final assistant text, and
exits nonzero when the turn does not complete successfully. Corrections start a
new DSH session in the same prepared worktree; context must therefore be
self-contained in every correction brief.

## Result envelope

Every invocation, including preflight and spawn failures, emits one JSON object
on stdout:

```json
{
  "protocolVersion": 1,
  "runnerVersion": "0.1.0",
  "status": "succeeded",
  "cwd": "/absolute/project",
  "dshPath": "/absolute/path/to/dsh",
  "executable": "/absolute/path/to/node-or-dsh",
  "profile": "headless",
  "sessionMode": "fresh_persisted",
  "outputFormat": "text",
  "exitCode": 0,
  "signal": null,
  "durationMs": 1234,
  "timedOut": false,
  "stdout": "final assistant text\n",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "dshOutput": { "format": "text", "raw": "final assistant text\n" },
  "retryable": false,
  "recovery": null
}
```

`status` is one of `succeeded`, `failed`, `timed_out`, and `spawn_error`.
Runner exit code `0` is reserved for `succeeded`; all other statuses are
nonzero. Failures add an `error` object whose code is one of:

- `invalid_input`
- `executable_not_found`
- `spawn_error`
- `dsh_exit_nonzero`
- `timed_out`
- `output_limit`
- `interrupted`
- `internal_error`

The Runner does not classify provider, model, authentication, or permission
errors from DSH text and never retries automatically. On failure, preserve and
inspect the prepared worktree. Any recovery run requires the workflow's
explicit recovery and external-data authorization and uses a new DSH session.

## Output, result file, and process lifecycle

After parsing, the CLI writes a `running` diagnostic to stderr. It emits the
JSON envelope only after the child closes. With `--prompt-file`, it also writes
the same envelope atomically to `<prompt-file>.result.json`; Unix permissions
are `0600`, while Windows relies on the containing directory's ACL.

Until an exit code is available, keep waiting on the same command session. For
ordinary tasks, start with a 15-second yield and then make one empty wait of up
to 180 seconds per round. For an explicitly long-running task, use 280-second
waits. Continue only while the terminal reports a live session ID; stop when it
returns an exit code. Do not inspect or mutate the temporary worktree while DSH
is still running.

Each stream retains at most 256 KiB, keeping head and tail fragments when
truncated. If either stream exceeds 1 MiB, the Runner terminates the process
tree and reports `output_limit`. It redacts common bearer tokens, API keys,
passwords, and the exact delegation prompt. Timeout, output-limit breach,
SIGINT, and parent SIGTERM request graceful tree termination, wait 2000 ms,
then force termination if needed.
