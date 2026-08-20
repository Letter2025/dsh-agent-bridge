---
name: dsh-worker
description: Compatibility entry point for delegating bounded coding tasks to a persistent DSH Web session through the co-installed dsh-agent bridge. Use when Codex should direct DSH to create and work inside a dsh-task-worktree checkout while Codex retains planning, review, verification, and bring-back approval.
---

# DSH Worker

Use this compatibility entry point when a task calls DSH a worker. It routes
through the co-installed `dsh-agent`; it is not a native Codex subagent.

Install `dsh-agent` beside this Skill, run the DSH Web profile on loopback, and
install `dsh-task-worktree` in that profile. The `dsh-agent` Web bridge is the
sole execution path.

Before acting, read `dsh-agent/SKILL.md` completely and follow it as the
authoritative workflow. In particular:

- obtain its explicit external-service data authorization even when Brief
  Review is `off`;
- let DSH create and manage the plugin worktree through its Web session;
- reuse the recorded DSH worker session for corrections; and
- independently review the candidate and obtain separate approval before
  DSH bring-back or removal.

Do not duplicate or weaken `dsh-agent` rules, tell DSH to invoke Codex
Skills, or assume those Skills are installed in DSH.
