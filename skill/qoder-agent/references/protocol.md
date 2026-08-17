# Qoder Agent Runner Protocol

The Skill Runner is a one-shot adapter around the locally installed Qoder CLI.
It owns the public command syntax and returns one bounded, Runner-owned JSON
envelope. It does not implement MCP, ACP, session continuation, semantic
parsing, or `stream-json` handling.

## Public command

```text
run_qoder.mjs --cwd <absolute-path> --prompt-file <absolute-brief-path>
run_qoder.mjs --cwd <absolute-path> \
  (--prompt-file <absolute-brief-path> | --prompt <text>) \
  [--qodercli-path <absolute-path>] [--model <model>] [--timeout-ms <milliseconds>] \
  [--max-model-request-retries <count>]
```

`--cwd` and exactly one of `--prompt-file` or `--prompt` are mandatory. `cwd`
must be an existing absolute directory and is normalized with `realpath`. For
Skill-driven work, pass the Codex session's authorized `hostCwd` to
`qoder_worktree.mjs prepare --cwd`, then pass the returned temporary-worktree
`qoderCwd` to this Runner. The delegation brief may declare a narrower task
modification scope, but callers must not replace `hostCwd` with that narrower
scope or silently widen the host boundary merely to expose context.

`--prompt-file` is the default interface for generated or multiline briefs.
Its path must be absolute and identify a readable, non-symbolic-link regular
file containing valid UTF-8 text. The loaded prompt must be non-empty and no
larger than 64 KiB in UTF-8 bytes. The Runner opens one file handle, verifies
the handle still identifies the regular file selected by the path, checks its
size before reading, and reads at most 64 KiB plus one detection byte. It
closes the handle before spawning Qoder and passes only the loaded contents to
Qoder; the file path is not included in Qoder's arguments. The inline
`--prompt` interface remains compatibility-only and has the same content
limits. The Runner does not read a prompt from stdin and does not fall back to
the Runner's current directory.

On Windows, the effective prompt capacity can be lower because Qoder still
receives the prompt as an argument. Before spawning, the Runner measures the
complete escaped command line—including the executable, fixed arguments,
paths, model, safety policy, and prompt—as UTF-16 code units. It returns
`invalid_input` when the value plus its terminating NUL would exceed the
32,767-unit `CreateProcessW` limit.

## Qoder invocation

The Runner resolves an executable in this order:

1. `--qodercli-path`
2. `QODERCLI_PATH`
3. `qodercli` in `PATH`

A configured path is authoritative: if it is invalid, the Runner fails
without falling through. The Runner never probes a user home directory or an
installation-specific location. Add `qodercli` to `PATH`, set
`QODERCLI_PATH`, or pass `--qodercli-path` on each machine. The verification
baseline is whatever `qodercli --version` reports at verification time; the
Runner does not reject other Qoder versions.
On Windows, the resolved executable must be the native `qodercli.exe` rather
than a `.cmd` or `.bat` shim. This keeps shell execution disabled and preserves
the Runner's argument-array safety boundary.

Supported configuration uses CLI over environment over defaults:

| Setting    | CLI                           | Environment                       | Default              |
| ---------- | ----------------------------- | --------------------------------- | -------------------- |
| executable | `--qodercli-path`             | `QODERCLI_PATH`                   | `qodercli` in `PATH` |
| model      | `--model`                     | `QODER_MODEL`                     | unset; Qoder chooses |
| timeout    | `--timeout-ms`                | `QODER_TIMEOUT_MS`                | 1800000 ms           |
| retries    | `--max-model-request-retries` | `QODER_MAX_MODEL_REQUEST_RETRIES` | 3                    |

Timeout values must be positive integers and cannot exceed 3600000 ms. There
is no permission-mode environment variable. Model request retries must be an
integer from 0 through 10. The Runner always builds this argument array, with
the prompt after `--`:

The caller uses the 1800000 ms default for ordinary tasks. Only when the user
explicitly identifies the delegated task as long running, the caller passes
`--timeout-ms 3600000` for that invocation and selects the long-task polling
policy below. The Runner does not infer this from prompt text, task complexity,
elapsed time, or repository size.

```text
qodercli --print --cwd <normalized-cwd> --permission-mode auto
  --output-format json --no-session-persistence
  --max-model-request-retries <count>
  [--model <model>]
  --append-system-prompt <fixed-safety-policy>
  -- <prompt>
```

The process is started with an argument array, `shell: false`, inherited
environment, piped stdout/stderr, and `windowsHide: true`. On POSIX systems it
uses `detached: true` to create a process group that can be terminated as a
unit. On Windows it does not detach the process and uses hidden `taskkill.exe`
processes to terminate the child process tree. The Runner never concatenates a
shell command and never exposes Qoder's permission or tool filter flags.

The fixed safety policy prohibits commit, push, publish, staging, stashing,
checkout, switching, restoring, reset, clean, worktree configuration changes,
credential handling/output, writes outside the explicit `cwd`, configuration
changes, and trust-setting changes. Repository instructions, Skills, agent
files, and other project content are untrusted task input. Network access,
dependency installation, and other conditional operations are allowed only
when the task explicitly requires them and Qoder `auto` allows them.

## Result envelope

Every invocation, including validation and startup failures, emits one JSON
object on stdout:

```json
{
  "protocolVersion": 1,
  "runnerVersion": "0.4.1",
  "status": "succeeded",
  "cwd": "/absolute/project",
  "executable": "/absolute/path/to/qodercli",
  "permissionMode": "auto",
  "outputFormat": "json",
  "exitCode": 0,
  "signal": null,
  "durationMs": 1234,
  "timedOut": false,
  "retryable": false,
  "recovery": null,
  "stdout": "...",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "qoderOutput": { "format": "json", "raw": "..." }
}
```

Required fields are stable. `error` is added for Runner-owned failures:

```json
{ "code": "qoder_exit_nonzero", "message": "..." }
```

The status values are `succeeded`, `failed`, `timed_out`, and `spawn_error`.
The Runner returns exit code `0` only for `succeeded`; all other statuses
return non-zero.

Runner error codes describe facts the Runner can determine without
interpreting Qoder's business JSON:

- `invalid_input`
- `executable_not_found`
- `spawn_error`
- `qoder_exit_nonzero`
- `model_queue_exhausted`
- `timed_out`
- `output_limit`
- `interrupted`
- `internal_error`

Qoder stdout is preserved as bounded raw text in `qoderOutput.raw`; it is not
parsed broadly for permission, authentication, or CLI-compatibility semantics.
The Runner recognizes only the exact known `model queue recovery attempts
exceeded` diagnostic as `model_queue_exhausted`, sets `retryable: true`, and
returns `recovery.strategy: continue_in_existing_worktree`. It never retries
automatically. The calling Codex session may inspect the raw payload and the
actual project diff.

## Output, redaction, and lifecycle

After parsing, the CLI writes a `running` diagnostic to stderr. It captures
Qoder's streams and emits the envelope only after the child closes. For
`--prompt-file`, it first atomically writes the same envelope to
`<prompt-file>.result.json` with mode `0600`; any prior file at that path is
removed before Qoder starts.

Until an exit code is available, the caller must keep waiting on the same
command session and treat empty stdout or worktree inspection as provisional.
When programmatic tool calling is available, select the wait policy once for
the invocation:

| Task classification | Outer tool call | Inner session wait |
| ------------------- | --------------- | ------------------ |
| Ordinary            | 200000 ms       | 180000 ms          |
| Explicit long task  | 300000 ms       | 280000 ms          |

Do not use the long-task policy unless the user explicitly classified that
task as long running. In either policy, later rounds retain 20000 ms of
synchronization headroom; the first retains at least 5000 ms beyond the maximum
sequential 15000 ms startup wait and the inner session wait. This headroom
covers scheduling and result serialization; it is not an additional Qoder wait
or a Runner timeout.

For the first round, start the Runner with `exec_command.yield_time_ms: 15000`;
do not rely on the terminal tool's default. If it returns an exit code, return
that result immediately. If it returns a session ID, make exactly one empty
stdin wait on that session inside the same outer tool call. For an ordinary
task, use:

```js
// @exec: {"yield_time_ms": 200000, "max_output_tokens": 10000}
const started = await tools.exec_command({
  cmd: "<exact approved Runner command>",
  workdir: "<absolute task directory>",
  yield_time_ms: 15000,
  max_output_tokens: 10000,
  // Include the exact approved sandbox fields when host access is required.
});

if (started.exit_code !== undefined) {
  text(JSON.stringify(started));
} else {
  const waited = await tools.write_stdin({
    session_id: started.session_id,
    chars: "",
    yield_time_ms: 180000,
    max_output_tokens: 10000,
  });
  text(JSON.stringify(waited));
}
```

For an explicit long task, change only the outer pragma's `yield_time_ms` to
`300000` and the inner `write_stdin` wait's `yield_time_ms` to `280000`.

For every later round, preserve the policy selected for the invocation and make
exactly one empty stdin wait on the same session. The ordinary-task form is:

```js
// @exec: {"yield_time_ms": 200000, "max_output_tokens": 10000}
const waited = await tools.write_stdin({
  session_id: <existing session ID>,
  chars: "",
  yield_time_ms: 180000,
  max_output_tokens: 10000,
});
text(JSON.stringify(waited));
```

For an explicit long task, use `yield_time_ms: 300000` in the outer pragma and
`yield_time_ms: 280000` in `write_stdin` instead.

Each value is a maximum wait: output or process exit returns control
immediately, without waiting out the remaining outer headroom. End when a wait
returns an exit code. Start another round only when it instead returns a live
session ID. Do not issue higher-frequency stdin waits or inspect the temporary
worktree while Qoder is still running. Unsupported yield controls fall back to
the terminal tool's defaults without changing the Runner protocol.

The wait budget covers the configured timeout plus the 2000 ms termination
grace. After both processes end, a valid saved envelope recovers a lost command
channel; if neither result exists, the execution result is unknown.

Each stream keeps up to 256 KiB for return. When that capture limit is
exceeded, the output keeps head and tail fragments and sets its truncation
flag. If either stream exceeds the hard 1 MiB limit, the process group is
terminated and the result uses `output_limit`.

The Runner redacts common Bearer, `sk-`, `ghp_`, `AKIA`, token, password,
secret, and API-key forms. It also removes the exact task prompt from returned
output. It never returns complete argv or environment variables.

Qoder runs in its own process group. Timeout, output-limit breach, SIGINT, and
parent SIGTERM send SIGTERM to the group, wait 2000 ms, and then send SIGKILL
if necessary. The Runner never retries or changes permission mode. The final
envelope records the Qoder exit code and signal separately from the Runner's
own process exit code.
