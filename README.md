# Qoder Agent Bridge

[简体中文](README.zh-CN.md)

Bridge Qoder into an agent workflow through bounded, one-shot Codex Skills.
The current milestone focuses exclusively on refining the reusable
`qoder-agent` Skill, its local Qoder CLI Runner, and `qoder-worker` compatibility
entry point. The goal is to stabilize the delegation contract, safety boundary,
context model, and product requirements before building another integration
surface.

## Feature status

| Feature                    | Status                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| Codex Skill integration    | Current focus; implemented and actively being refined                     |
| MCP integration            | Planned feature; development begins only after the Skill contract matures |
| ACP integration            | Planned feature; no implementation work is scheduled in the current phase |
| Rich session orchestration | Future consideration; not part of the current one-shot Skill milestone    |

MCP and ACP are product directions, not current capabilities. This phase will
first collect and validate Skill requirements, usage constraints, and review
semantics; those findings will shape any later MCP design.

## Current Skill features

- One-shot, non-interactive delegation through the local Qoder CLI, with
  `qoder-worker` available as a compatibility alias.
- Context-aware delegation briefs compiled by Codex from applicable project
  instructions, OpenSpec artifacts, specifications, and portable guidance from
  installed Codex Skills. Qoder does not need those Skills installed.
- Progressive brief construction: simple tasks use a short base contract;
  project context and specialized rules are added only when relevant.
- Three-state Brief Review (Spec) policy: explicit `required` and `off` modes,
  plus risk-based `auto` mode by default. Spec mode previews the delegation
  brief; it is not OpenSpec generation.
- Narrow working-directory and fixed safety boundaries that prohibit writes
  outside `cwd`, credential handling, publication, and Git-history operations.
- Temporary detached worktrees for code-changing tasks, exact Qoder-only patch
  generation, independent review, conflict preflight, and explicit approval
  before applying changes to the source worktree.
- Safe prompt-file transport with bounded, identity-checked reads and no shell
  interpolation of generated or multiline briefs.
- Structured result envelopes, bounded retries and output capture, redaction,
  timeouts, signal handling, and platform-specific process-tree termination.
- In-place review correction, trustworthy failed-Runner recovery, and linked
  clean-restart cleanup without relying on persistent Qoder sessions.

## Important notes

- Codex remains the planner, context compiler, reviewer, and acceptance owner;
  Qoder is a bounded coding executor, not an autonomous peer session.
- Code-changing worktree isolation requires a Git repository with a `HEAD`
  commit and no unmerged paths. Ignored files are unavailable by default; a
  root `.qoderinclude` can optionally snapshot ignored build inputs when they
  exist locally.
- Keep `cwd` at the narrowest real write boundary. Context outside it must be
  summarized into the brief rather than exposed by widening Qoder's writable
  scope.
- Brief approval authorizes one Qoder execution only. Applying the reviewed
  patch to the source worktree always requires separate explicit approval.
- Qoder authentication and any required host/network access must already be
  available locally. Stop on execution failure and never retry automatically or
  with broader permissions. After approval, continue trustworthy partial work
  in the same prepared worktree once external prerequisites are resolved.
- Never place credentials or secrets in a delegation brief. Write generated
  briefs with a non-shell file-writing tool and pass them with `--prompt-file`.
- The prompt content limit is 64 KiB, but Windows can have a lower effective
  capacity because the complete `CreateProcessW` command line is limited. The
  Runner preflights this and returns `invalid_input` before spawning Qoder.
- `qoder-worker` requires the co-installed `qoder-agent`; both entry points use
  the same Runner and safety policy.

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

The default timeout is 30 minutes. When the user explicitly identifies a
delegated task as long running, the Skill passes `--timeout-ms 3600000` to give
that invocation a one-hour timeout and changes result polling from the ordinary
200-second outer/180-second inner waits to 300-second outer/280-second inner
waits.

Invoke `$qoder-agent` or `$qoder-worker`; both use the same Runner. Read
[skill/qoder-agent/SKILL.md](skill/qoder-agent/SKILL.md) for the Codex
collaboration workflow,
[skill/qoder-agent/references/delegation-prompt.md](skill/qoder-agent/references/delegation-prompt.md)
for the context-aware `Qoder Delegation Brief v1` compiled by Codex,
[skill/qoder-agent/references/worktree-review.md](skill/qoder-agent/references/worktree-review.md)
for the isolated review, correction, recovery, and apply lifecycle, and
[skill/qoder-agent/references/protocol.md](skill/qoder-agent/references/protocol.md)
for the result envelope.

## Isolated worktree lifecycle

Code-changing tasks use a temporary detached Git worktree. The coordinator
mirrors tracked and non-ignored source state. A repository-root `.qoderinclude`
may select ignored files, such as generated OpenAPI schemas, as copied check
inputs when they exist locally. These files never enter the baseline, review patch, or
source apply operation.

`.qoderinclude` uses repository-relative glob patterns. Ordinary rules include,
`!` rules exclude, and the last matching rule wins. Missing matches, tracked or
non-ignored matches, and matches outside the requested `cwd` are skipped without
failing `prepare`; a non-empty configuration with no local matches produces an
empty manifest. Git efficiently enumerates ordinary ignored files, while a
glob-directed filesystem scan detects matched special files without imposing
literal-root restrictions on patterns such as `*.json`, `generated/*.ts`, or
`packages/*/generated/**`. The snapshot is limited to 20,000 entries and
256 MiB. Unsafe links, special files, invalid paths, and over-limit selections
make `prepare` fail. This project declaration does not authorize disclosure of
secrets or unrelated local data to Qoder.

The v2 session validates the manifest against its recorded SHA-256 and
summary to detect accidental coordinator-state damage. Inspect, review, reopen,
and apply share its exclusion set. Included ignored artifacts may change inside
the temporary worktree, but their prepared paths remain local check inputs and
cannot enter the Qoder-only patch or source apply operation. This is a
cooperative integrity check, not a sandbox against a malicious worker.

After explicit review approval, `apply` checks and applies the Qoder-only patch
without staging the source, then automatically removes the temporary worktree and session. If
application fails, the session is retained for diagnosis; if cleanup fails
after application, retry `dispose --state <statePath>`. Use
`dispose --state <statePath> --discard` only to discard an unapplied session.
Use `reopen --state <statePath>` for a rejected review candidate; it archives
the old patch and preserves the complete working tree for correction. A
trustworthy failed Runner also continues in the same prepared worktree after
inspection and explicit approval. Use `prepare --retry-of
<previous-statePath>` only for a clean restart or an unsafe-to-reuse session. A
successful apply then removes the new session and its linked predecessors.

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
