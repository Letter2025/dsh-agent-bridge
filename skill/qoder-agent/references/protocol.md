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
must be an existing absolute directory and is normalized with `realpath`. It
should be the narrowest actual write boundary for the task, not a broader
directory chosen merely to expose read-only context.

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
| timeout    | `--timeout-ms`                | `QODER_TIMEOUT_MS`                | 900000 ms            |
| retries    | `--max-model-request-retries` | `QODER_MAX_MODEL_REQUEST_RETRIES` | 3                    |

Timeout values must be positive integers and cannot exceed 3600000 ms. There
is no permission-mode environment variable. Model request retries must be an
integer from 0 through 10. The Runner always builds this argument array, with
the prompt after `--`:

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
When supported by the terminal tool, the Skill requests an initial yield of at
most 30000 ms and then empty stdin waits with `yield_time_ms: 180000` on that
same session. Each value is a maximum wait: output or process exit returns
control immediately. A caller should issue another wait only when the prior
one returns without an exit code, and should not add higher-frequency polling.
Unsupported yield controls fall back to the terminal tool's defaults without
changing the Runner protocol.

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
