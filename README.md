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

The public command requires the narrowest absolute directory that contains the
expected changes and a bounded task brief. Write generated or multiline briefs
to a private file with a non-shell editor or file-writing tool:

```sh
node skill/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/task-scope \
  --prompt-file /absolute/path/to/delegation-brief.md
```

The inline `--prompt` form remains available for compatibility, but generated
briefs must not be interpolated into a shell command.

Optional flags are `--qodercli-path`, `--model`, `--timeout-ms`, and
`--max-model-request-retries`. The environment equivalents are
`QODERCLI_PATH`, `QODER_MODEL`, `QODER_TIMEOUT_MS`, and
`QODER_MAX_MODEL_REQUEST_RETRIES`. The Runner always uses `permission-mode
auto`, JSON output, no session persistence, argument-array spawning, bounded
model retries and output, redaction, hidden Windows subprocesses, and
platform-specific process-tree termination.

Invoke `$qoder-agent` or `$qoder-worker`; both use the same Runner. Read
[skill/qoder-agent/SKILL.md](skill/qoder-agent/SKILL.md) for the Codex
collaboration workflow,
[skill/qoder-agent/references/delegation-prompt.md](skill/qoder-agent/references/delegation-prompt.md)
for the context-aware `Qoder Delegation Brief v1` compiled by Codex, and
[skill/qoder-agent/references/protocol.md](skill/qoder-agent/references/protocol.md)
for the result envelope.

## Isolated worktree lifecycle

Code-changing tasks use a temporary detached Git worktree. The coordinator
mirrors tracked and non-ignored source state only; ignored dependencies such
as `node_modules` are not copied, linked, or installed. After explicit review
approval, `apply` checks and applies the Qoder-only patch without staging the
source, then automatically removes the temporary worktree and session. If
application fails, the session is retained for diagnosis; if cleanup fails
after application, retry `dispose --state <statePath>`. Use
`dispose --state <statePath> --discard` only to discard an unapplied session.
When starting a new attempt after a failed session, pass
`--retry-of <previous-statePath>` to `prepare`. A successful apply then removes
the new session and its linked predecessor sessions; a failed retry retains the
whole chain.

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

The maintained implementation lives in TypeScript under `packages/core` and
`packages/cli`. `packages/core` owns the reusable Runner and worktree lifecycle;
`packages/cli` owns argument parsing, process signals, JSON output, and exit
codes and depends on core through the `@qoder-agent-bridge/core` workspace
package boundary. TypeScript source uses bundler-style extensionless imports.
`pnpm build` emits package artifacts and regenerates the committed,
self-contained Skill executables in `skill/qoder-agent/scripts/`. Do not edit
those generated `.mjs` files directly.

## Optional real verification

Default checks use fake child-process boundaries and do not invoke a Qoder
model. For an explicit end-to-end check, use a disposable repository outside
this project and create its baseline commit manually. Before running the
commands, use a trusted editor or non-shell file-writing tool to create the
private file `/absolute/path/to/qoder-verification-brief.md` outside the
fixture, containing the bounded verification task:

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
  --prompt-file /absolute/path/to/qoder-verification-brief.md

git -C "$fixture" status --short
git -C "$fixture" diff
git -C "$fixture" remote -v
```

If Qoder reports permission denial, authentication failure, timeout, or any
other failure, stop and inspect the returned envelope. Do not retry with a
different permission mode.

## License

MIT. See [LICENSE](LICENSE).
