# Qoder Agent and Worker Skills

The first milestone is intentionally a small one-shot adapter. Codex remains
the planning, review, and acceptance agent; Qoder receives only a bounded task
prompt and an explicit trusted working directory. `qoder-worker` is a
compatibility entry point that delegates through `qoder-agent`; it is not a
native Codex subagent.

## Operating contract

- Use `node skill/qoder-agent/scripts/run_qoder.mjs --cwd <narrow-absolute-path> --prompt-file <absolute-brief-path>`.
- Keep `cwd` outside the Runner's implicit state; no current-directory fallback exists.
- Keep `cwd` at the narrowest real write boundary. Compile relevant context into
  the brief instead of widening the writable directory merely so Qoder can read it.
- Write generated or multiline briefs with a non-shell file-writing tool. Never
  interpolate them into a shell command; inline `--prompt` is compatibility-only.
- Make `qodercli` available on `PATH` for the Codex process, or configure an
  absolute `QODERCLI_PATH`; the Runner never probes a user-specific home path.
- Keep prompts free of tokens, passwords, API keys, and other credentials.
- Treat the returned envelope as execution evidence, not as a replacement for
  inspecting the actual diff and tests.
- Stop on Runner failure and do not retry automatically or with broader
  permissions. After inspection and approval, continue trustworthy partial work
  in the same prepared worktree; create a fresh linked retry only for a clean
  restart or unsafe state.
- Never ask Qoder to commit, push, publish, reset, clean, or edit outside the
  explicit task directory.

## Installation

Copy both Skill directories to either:

- `<project>/.codex/skills/qoder-agent/` for project-local use;
- `<project>/.codex/skills/qoder-worker/` for the worker-style alias;
- `~/.codex/skills/qoder-agent/` or the configured Codex skills directory for
  personal use, alongside `qoder-worker/`.

`qoder-agent` contains `SKILL.md`, `agents/openai.yaml`, the Runner and
delegation-prompt protocol references, and self-contained generated executables
under `scripts/`.
Their TypeScript sources live in `packages/core` and `packages/cli`; regenerate
them with `pnpm build` instead of editing the `.mjs` files. `qoder-worker`
contains the alias metadata and instructions, and requires the co-installed
`qoder-agent`.

## Verification evidence

The deterministic suite uses a fake child-process boundary and covers command
construction, preflight validation, process lifecycle, output limits, and
redaction. A real Qoder run is intentionally opt-in. When performing one,
create a temporary Git repository outside this project, make its baseline
commit manually, leave its remote list empty, invoke the Runner once, and
independently inspect `git status --short`, `git diff`, and the returned
envelope. The Runner must not create commits or push changes.

The local verification baseline records `qodercli --version` but accepts a
different installed version unless a future protocol explicitly requires a
compatibility gate.
