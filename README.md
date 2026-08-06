# Qoder Agent Bridge

[简体中文](README.zh-CN.md)

Bridge Qoder into an agent workflow through bounded, one-shot Codex Skills.
The first milestone contains the reusable `qoder-agent` Skill and local Qoder
CLI Runner, plus `qoder-worker` as a compatibility entry point for worker-style
delegation. MCP, ACP, session orchestration, and continuation are out of scope
for this milestone.

## Requirements

- Node.js `>=22.18.0`
- pnpm `9.15.4` or a compatible pnpm 9 release
- A locally installed and authenticated Qoder CLI

Make `qodercli` available on `PATH` for the Codex process, or configure its
absolute path with `QODERCLI_PATH` (or `--qodercli-path` for one invocation).
On Windows, configure the native `qodercli.exe`; command shims such as
`qodercli.cmd` and `qodercli.bat` are rejected so the Runner can keep
`shell: false` and preserve argument boundaries.
The Runner never guesses an installation path beneath a user's home directory.
It records the Qoder version used during verification but does not hard-fail on
a different CLI version.

## Install the Skill

For a project-local Skill:

```sh
mkdir -p /path/to/project/.codex/skills
cp -R skill/qoder-agent /path/to/project/.codex/skills/qoder-agent
cp -R skill/qoder-worker /path/to/project/.codex/skills/qoder-worker
```

For personal use, copy both directories to `~/.codex/skills/` or the configured
Codex skills directory. `qoder-worker` is a compatibility alias that requires
the co-installed `qoder-agent`; keep the executable bit on its
`scripts/run_qoder.mjs`.

## Run the Runner

The public command requires an absolute project directory and a bounded task:

```sh
node skill/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/project \
  --prompt "Implement the requested change and run the relevant tests. Do not commit or push."
```

Optional flags are `--qodercli-path`, `--model`, and `--timeout-ms`. The
environment equivalents are `QODERCLI_PATH`, `QODER_MODEL`, and
`QODER_TIMEOUT_MS`. The Runner always uses `permission-mode auto`, JSON output,
no session persistence, argument-array spawning, output bounds, redaction,
hidden Windows subprocesses, and platform-specific process-tree termination.

Invoke `$qoder-agent` or `$qoder-worker`; both use the same Runner. Read
[skill/qoder-agent/SKILL.md](skill/qoder-agent/SKILL.md) for the Codex
collaboration workflow and
[skill/qoder-agent/references/protocol.md](skill/qoder-agent/references/protocol.md)
for the result envelope.

## Development checks

```sh
pnpm install
pnpm skill:check
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

The Skill Runner is committed and executed directly from
`skill/qoder-agent/`; package builds cover only the existing workspace
packages and do not emit a second Runner copy under `dist/`.

## Optional real verification

Default checks use fake child-process boundaries and do not invoke a Qoder
model. For an explicit end-to-end check, use a disposable repository outside
this project and create its baseline commit manually:

```sh
fixture="$(mktemp -d /tmp/qoder-agent-fixture.XXXXXX)"
printf 'before\n' > "$fixture/example.txt"
git -C "$fixture" init
git -C "$fixture" config user.name "Qoder Fixture"
git -C "$fixture" config user.email "qoder-fixture@example.invalid"
git -C "$fixture" add example.txt
git -C "$fixture" commit -m baseline

qodercli --version
node skill/qoder-agent/scripts/run_qoder.mjs \
  --cwd "$fixture" \
  --prompt "Change example.txt to contain exactly one additional line, run a relevant check, and do not commit, push, publish, reset, or clean."

git -C "$fixture" status --short
git -C "$fixture" diff
git -C "$fixture" remote -v
```

If Qoder reports permission denial, authentication failure, timeout, or any
other failure, stop and inspect the returned envelope. Do not retry with a
different permission mode.

## License

MIT. See [LICENSE](LICENSE).
