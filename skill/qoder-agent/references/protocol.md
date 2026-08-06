# Qoder Agent Runner Protocol

The Skill Runner is a one-shot adapter around the locally installed Qoder CLI.
It owns the public command syntax and returns one bounded, Runner-owned JSON
envelope. It does not implement MCP, ACP, session continuation, semantic
parsing, or `stream-json` handling.

## Public command

```text
run_qoder.mjs --cwd <absolute-path> --prompt <text>
run_qoder.mjs --cwd <absolute-path> --prompt <text> \
  [--qodercli-path <absolute-path>] [--model <model>] [--timeout-ms <milliseconds>]
```

`--cwd` and `--prompt` are mandatory. `cwd` must be an existing absolute
directory and is normalized with `realpath`. The prompt must be non-empty and
no larger than 64 KiB in UTF-8 bytes. The Runner does not read a prompt from
stdin and does not fall back to the Runner's current directory.

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

Supported configuration uses CLI over environment over defaults:

| Setting    | CLI               | Environment        | Default              |
| ---------- | ----------------- | ------------------ | -------------------- |
| executable | `--qodercli-path` | `QODERCLI_PATH`    | `qodercli` in `PATH` |
| model      | `--model`         | `QODER_MODEL`      | unset; Qoder chooses |
| timeout    | `--timeout-ms`    | `QODER_TIMEOUT_MS` | 300000 ms            |

Timeout values must be positive integers and cannot exceed 1800000 ms. There
is no permission-mode environment variable. The Runner always builds this
argument array, with the prompt after `--`:

```text
qodercli --print --cwd <normalized-cwd> --permission-mode auto
  --output-format json --no-session-persistence
  [--model <model>]
  --append-system-prompt <fixed-safety-policy>
  -- <prompt>
```

The process is started with an argument array, `shell: false`, inherited
environment, `detached: true`, and piped stdout/stderr. The Runner never
concatenates a shell command and never exposes Qoder's permission or tool
filter flags.

The fixed safety policy prohibits commit, push, publish, reset, clean,
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
  "runnerVersion": "0.1.0",
  "status": "succeeded",
  "cwd": "/absolute/project",
  "executable": "/absolute/path/to/qodercli",
  "permissionMode": "auto",
  "outputFormat": "json",
  "exitCode": 0,
  "signal": null,
  "durationMs": 1234,
  "timedOut": false,
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
- `timed_out`
- `output_limit`
- `interrupted`
- `internal_error`

Qoder stdout is preserved as bounded raw text in `qoderOutput.raw`; it is not
parsed for permission, authentication, or CLI-compatibility semantics. The
calling Codex session may inspect that raw payload and the actual project diff.

## Output, redaction, and lifecycle

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
