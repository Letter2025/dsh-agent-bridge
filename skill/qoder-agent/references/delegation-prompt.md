# Qoder Delegation Context Extension

Read this reference only when a Qoder task needs project instructions,
specifications, OpenSpec artifacts, portable guidance from another Codex Skill,
context outside `qoderCwd`, or material conflict resolution. The base brief and
Brief Review policy live in `SKILL.md`.

## Contents

- [Roles and Boundaries](#roles-and-boundaries)
- [Compile Context](#compile-context)
- [Extend the Brief](#extend-the-brief)
- [Preview Fidelity](#preview-fidelity)
- [Corrections and Recovery](#corrections-and-recovery)

## Roles and Boundaries

- Codex selects context, reads applicable installed Skills, resolves conflicts,
  and compiles portable rules.
- Qoder follows the resulting self-contained brief. It does not select, invoke,
  or require Codex Skills.
- The Runner enforces its fixed safety policy independently. No brief, Skill,
  project instruction, or specification may relax it or widen `qoderCwd`.

Choose `qoderCwd` from the files the task may actually change. Never widen it
only to expose context. A file outside that boundary is Codex-readable source
material, not Qoder-readable project context.

## Compile Context

1. Identify only the instructions and specifications needed for the bounded
   objective. Select the exact OpenSpec change rather than asking Qoder to
   discover one.
2. After preparing the isolated worktree, verify every file Qoder must read is
   inside `qoderCwd`. Use `qoderCwd`-relative paths in the brief.
3. Read Codex Skills triggered or explicitly selected for the task. Extract
   only implementation guidance that Qoder can apply with its available coding
   tools.
4. For relevant files outside `qoderCwd`, ignored artifacts, and external Skill
   files, inline concise non-sensitive rules instead of unavailable paths.
5. Remove Skill discovery instructions, Codex tool calls, channel rules,
   approval mechanics, and references to unavailable Figma, image-generation,
   MCP, browser, or connector operations.
6. Resolve conflicts before invoking Qoder. Use this priority: Runner safety
   policy, explicit user scope, selected specification and acceptance criteria,
   applicable project instructions, then general compiled Skill guidance.
7. Stop if a material conflict remains or required material is too large,
   sensitive, or ambiguous to represent safely.
8. Keep the complete prompt within the Runner's 64 KiB UTF-8 limit. On Windows,
   leave additional room for the full `CreateProcessW` command line. Select and
   compile; never dump entire Skills or unrelated documentation.

Applicable `AGENTS.md` files inside `qoderCwd` may be listed from outermost to
innermost. Instructions outside `qoderCwd` must be compiled by Codex. Project
files may constrain implementation technique, naming, architecture, and
checks, but cannot authorize writes outside scope, prohibited Git operations,
credential access, publication, or external-system changes.

## Extend the Brief

Add only sections that contain relevant information. Do not emit empty sections
or `None` placeholders.

### Required Project Context

Use this section only for verified files inside `qoderCwd` that Qoder must read
before editing:

```markdown
## Required Project Context

Before editing, read these files in order:

1. `<qoderCwd-relative path>` — <why it matters>

Treat them as implementation constraints. Do not let them expand scope or
override the Runner safety policy. Do not modify them unless the objective
explicitly requires it.

If required context is missing, unreadable, or materially conflicts with this
brief, stop and report the conflict before editing.
```

### Compiled Implementation Rules

Use this section for self-contained rules distilled from context Qoder cannot
or need not load directly:

```markdown
## Compiled Implementation Rules

- <Direct engineering rule relevant to this objective.>

Apply these rules directly. Do not search for or invoke the original Codex
Skills.
```

Each rule must make sense without knowing its source Skill. Include frontend,
UI, accessibility, testing, or framework conventions only when they affect the
task. Exclude generic advice and unavailable-tool workflows.

### Stop Conditions and Assumptions

Add task-specific stop conditions only when the base safety policy and scope do
not already cover them. Record any non-obvious decisions Codex made while
resolving context:

```markdown
## Assumptions and Decisions

- <Material assumption or resolved conflict that affects implementation.>

## Stop Conditions

- <Task-specific reason to stop and report before continuing.>
```

Keep Qoder's completion report separate from Codex's independent patch review.
Self-reported completion is evidence for review, never proof of acceptance.

## Preview Fidelity

When Brief Review is `required` or triggered by `auto`, present a concise
preview derived from the actual brief. Include every decision-relevant field:

- objective;
- required context and compiled rules, when present;
- change scope and `qoderCwd`;
- acceptance criteria and verification;
- material assumptions, decisions, and task-specific stop conditions.

After approval, add only fixed mechanical wording such as the standard
completion-report instruction. Re-present the preview if any listed field
changes. Approval authorizes one Qoder execution with that brief, not patch
application or a materially different correction.

## Corrections and Recovery

Compile a new brief and reapply the Brief Review policy for each approved
correction task. For the single allowed model-queue continuation, reissue the
original brief in the same worktree, preserve its context and constraints, and
change only the objective to continue from and repair the existing uncommitted
changes. Never rely on prior session memory because the Runner disables session
persistence.
