# DSH Agent Bridge

[简体中文](README.zh-CN.md)

DSH Agent Bridge combines Codex and DeepSeek Harness in a bounded coding
workflow. Codex plans, compiles context, reviews, and accepts. DSH codes inside
its own permanent task worktree and receives implementation and correction
turns through one persistent Web Session.

This project is derived from the MIT-licensed
[`lei233/qoder-agent-bridge`](https://github.com/lei233/qoder-agent-bridge).
Its workspace layer is redesigned for DSH Web RPC and
[`dsh-task-worktree`](https://github.com/Letter2025/dsh-task-worktree).

## Workflow

```text
Codex plans
  → DSH controller session executes /worktree create
  → dsh-task-worktree creates a permanent checkout
  → the bridge validates path, branch, and base commit
  → DSH worker session opens with cwd inside that checkout
  → DSH implements ↔ Codex reviews and requests corrections
  → user approves
  → DSH executes /worktree bring-back
```

Codex never imports or directly invokes `dsh-task-worktree`. Every plugin
operation executes inside DSH through its Web RPC and command registry.

## Highlights

- Reuses one DSH worker session for implementation and correction turns.
- Uses branch-backed permanent worktrees owned by `dsh-task-worktree`.
- Accepts only loopback DSH Web URLs.
- Validates the worktree path, Git registration, branch, HEAD, and clean start.
- Requires a clean source worktree. A remote push is unnecessary, but the full
  baseline must exist in local `HEAD`.
- Requires `.dsh-worktrees/` in the committed `.gitignore` so plugin
  preparation cannot dirty the source checkout.
- Keeps Codex responsible for independent diff review and verification.
- Requires separate approval before DSH bring-back or removal.
- Retains the original headless Runner as an explicit legacy mode.

## Requirements

- Node.js `>=22.18.0`
- pnpm 9
- A compatible DeepSeek Harness `0.1.0-rc.7` installation
- Git 2.31+
- `dsh-task-worktree` installed in the Web profile
- A working DSH model configuration

```powershell
dsh plugin --profile web add dsh-task-worktree
dsh --profile web --no-open
```

The default URL is `http://127.0.0.1:3080`. Use `DSH_WEB_URL` or `--web-url`
for another loopback port.

## Install the Skills

Copy `skill/dsh-agent` and `skill/dsh-worker` into a project's
`.codex/skills/` directory or the personal Codex skills directory.

Invoke the main Skill with `$dsh-agent`. It prepares the DSH-owned worktree,
builds a bounded brief, reuses the worker session for corrections, reviews the
candidate, and waits for explicit approval before bring-back.

## Web CLI

```powershell
node skill/dsh-agent/scripts/dsh_web.mjs prepare `
  --cwd C:\absolute\project `
  --name codex/task-name

node skill/dsh-agent/scripts/dsh_web.mjs run `
  --state C:\absolute\state.json `
  --prompt-file C:\absolute\delegation-brief.md

node skill/dsh-agent/scripts/dsh_web.mjs inspect --state C:\absolute\state.json
node skill/dsh-agent/scripts/dsh_web.mjs status --state C:\absolute\state.json

# Explicit user approval required:
node skill/dsh-agent/scripts/dsh_web.mjs bring-back --state C:\absolute\state.json
node skill/dsh-agent/scripts/dsh_web.mjs remove --state C:\absolute\state.json
```

See [the Skill](skill/dsh-agent/SKILL.md),
[the Web protocol](skill/dsh-agent/references/protocol.md), and
[the review lifecycle](skill/dsh-agent/references/worktree-review.md) for the
complete contract.

## Development

```powershell
pnpm install
pnpm skill:check
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

TypeScript sources live under `packages/core` and `packages/cli`. `pnpm build`
regenerates the self-contained Skill executables in
`skill/dsh-agent/scripts/`; do not edit generated `.mjs` files directly.

## License

MIT. See [LICENSE](LICENSE).
