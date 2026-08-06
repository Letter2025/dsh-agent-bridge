---
name: qoder-worker
description: Compatibility entry point for delegating bounded coding tasks to a locally installed Qoder CLI through the co-installed qoder-agent Runner. Use when Codex should invoke Qoder as an external coding worker while retaining responsibility for scope, safety, diff review, and acceptance.
---

# Qoder Worker

Use this compatibility Skill when a task refers to Qoder as a worker. It
delegates through the co-installed `qoder-agent` Skill; it does not create a
native Codex subagent.

## Prerequisite

Install `qoder-agent` alongside this Skill in the same Codex skills directory.
Its `scripts/run_qoder.mjs` Runner is the sole Qoder execution path.
On each machine, make `qodercli` available on `PATH` for the Codex process, or
configure an absolute `QODERCLI_PATH`; the Runner does not guess a user-home
installation path.

## Invoke the Worker

Run the co-installed Runner with an absolute project directory and a bounded
task:

```sh
node /path/to/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/project \
  --prompt "Implement the bounded task and run the relevant tests. Do not commit or push."
```

Follow the safety and review workflow in the co-installed
`qoder-agent/SKILL.md`. Review the returned envelope, actual diff, `git
status`, and test output independently before accepting the work.
