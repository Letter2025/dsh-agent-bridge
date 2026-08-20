# DSH Agent and Worker Skills

The first milestone is intentionally a small one-shot adapter. Codex remains
the planning, review, and acceptance agent; DSH receives only a bounded task
prompt and an explicit trusted working directory. `dsh-worker` is a
compatibility entry point that delegates through `dsh-agent`; it is not a
native Codex subagent.

## Operating contract

- For worktree tasks, pass the Codex session's authorized `hostCwd` to
  `dsh_worktree.mjs prepare --cwd`, then pass the returned `dshCwd` to
  `run_dsh.mjs --cwd`.
- Keep `cwd` outside the Runner's implicit state; no current-directory fallback exists.
- Keep the host boundary inherited from the Codex session. Declare the narrower
  task modification scope in the brief instead of deriving `hostCwd` from the
  expected changed files. If the host session is limited to a subdirectory,
  DSH must not access files outside it.
- Write generated or multiline briefs with a non-shell file-writing tool. Never
  interpolate them into a shell command; inline `--prompt` is compatibility-only.
- Make `dsh` available on `PATH` for the Codex process, or configure an
  absolute `DSH_PATH`. Windows npm shims are resolved without shell interpolation.
- Keep prompts free of tokens, passwords, API keys, and other credentials.
- Treat the returned envelope as execution evidence, not as a replacement for
  inspecting the actual diff and tests.
- Stop on Runner failure and do not retry automatically or with broader
  permissions. After inspection and approval, continue trustworthy partial work
  in the same prepared worktree; create a fresh linked retry only for a clean
  restart or unsafe state.
- Never ask DSH to commit, push, publish, reset, clean, or edit outside the
  explicit task scope. The fixed task policy forbids writes outside `dshCwd`;
  the worktree boundary and independent diff review remain the acceptance guard.

## Installation

Copy both Skill directories to either:

- `<project>/.codex/skills/dsh-agent/` for project-local use;
- `<project>/.codex/skills/dsh-worker/` for the worker-style alias;
- `~/.codex/skills/dsh-agent/` or the configured Codex skills directory for
  personal use, alongside `dsh-worker/`.

`dsh-agent` contains `SKILL.md`, `agents/openai.yaml`, the Runner and
delegation-prompt protocol references, and self-contained generated executables
under `scripts/`.
Their TypeScript sources live in `packages/core` and `packages/cli`; regenerate
them with `pnpm build` instead of editing the `.mjs` files. `dsh-worker`
contains the alias metadata and instructions, and requires the co-installed
`dsh-agent`.

## Verification evidence

The deterministic suite uses a fake child-process boundary and covers command
construction, preflight validation, process lifecycle, output limits, and
redaction. A real DSH run is intentionally opt-in. When performing one,
create a temporary Git repository outside this project, make its baseline
commit manually, leave its remote list empty, invoke the Runner once, and
independently inspect `git status --short`, `git diff`, and the returned
envelope. The Runner must not create commits or push changes.

The local verification baseline records `dsh --version` but accepts a
different installed version unless a future protocol explicitly requires a
compatibility gate.
