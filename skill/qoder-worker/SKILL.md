---
name: qoder-worker
description: Compatibility entry point for delegating bounded coding tasks to a locally installed Qoder CLI through the co-installed qoder-agent Runner. Use when Codex should invoke Qoder as an external coding worker, compile relevant project context and installed Skill rules into a self-contained task brief, and retain responsibility for isolated worktrees, exact diff review, safe application, and acceptance.
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

## Host Execution Requirement

When Codex invokes the Runner or the co-installed worktree coordinator, execute
that one command with host access (`sandbox_permissions: "require_escalated"`)
after obtaining the user's approval. Qoder CLI requires its local login state
and host network access, including a loopback proxy; isolated worktree setup
needs access to the repository's Git metadata. A restricted command sandbox
can hide those from the child process, causing an early network failure even
when Codex itself is configured with a working proxy.

Keep the escalation limited to the exact `node .../run_qoder.mjs` or `node
.../qoder_worktree.mjs` command and state that it is needed for Qoder
authentication, network access, or Git metadata access. Do not request a
reusable broad approval for arbitrary Node or shell commands. This does not
change the Runner's fixed safety policy, absolute `cwd` requirement, or Qoder
`permission-mode auto`.

## Invoke the Worker

Before invoking Qoder, read the co-installed `qoder-agent/SKILL.md` and follow
its base brief, progressive context extension, narrow `cwd`, and three-state
Brief Review (Spec) policy. Read `references/delegation-prompt.md` only when its
context-extension triggers apply. Do not tell Qoder to invoke Codex Skills or
assume they are installed in Qoder. Follow its external-service data
authorization protocol before every initial Runner invocation or failed-run
recovery; Brief Review `off` does not waive that authorization.

Run the co-installed Runner with the narrowest absolute task directory that
contains the expected changes and the compiled brief:

```sh
node /path/to/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/task-scope \
  --prompt-file /absolute/path/to/delegation-brief.md
```

In Codex, submit this command with `sandbox_permissions:
"require_escalated"`. Never use an escalation to add Qoder permission
overrides, tool filters, or system-prompt overrides.

Create the brief file with a non-shell file-writing tool. Never interpolate
the brief into the command or use shell redirection, command substitution, or
a heredoc to write it. The inline `--prompt` option is compatibility-only.

Follow the isolated worktree workflow in the co-installed
`qoder-agent/SKILL.md`. Run Qoder in the coordinator's returned `qoderCwd`,
review its exact patch and test output, then wait for explicit user approval
before invoking the coordinator's safe `apply` operation. Never automatically
apply, force, or discard a Qoder review session.
