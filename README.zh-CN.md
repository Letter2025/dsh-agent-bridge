# Qoder Agent Bridge

[English](README.md)

通过受边界约束的一次性 Codex Skill 将本机 Qoder 接入 Agent 工作流。
当前阶段只聚焦于打磨可复用的 `qoder-agent` Skill、本地 Qoder CLI Runner，以及
兼容 worker 式委派的 `qoder-worker` 入口。现阶段的目标是先稳定委派契约、安全
边界、上下文模型并整理完整需求，再开发其他集成形态。

## Feature 状态

| Feature          | 状态                                            |
| ---------------- | ----------------------------------------------- |
| Codex Skill 集成 | 当前重点；已实现并持续打磨                      |
| MCP 集成         | 规划中的 Feature；待 Skill 契约成熟后再考虑开发 |
| ACP 集成         | 规划中的 Feature；当前阶段暂不安排实现          |
| 完整会话编排     | 后续方向；不属于当前 one-shot Skill 阶段        |

MCP 和 ACP 是产品规划方向，并非当前已经提供的能力。当前阶段会优先收集并验证
Skill 的需求、使用约束和审阅语义，这些结论将作为后续 MCP 设计的输入。

## 当前 Skill 支持的特性

- 通过本地 Qoder CLI 进行 one-shot、非交互式委派；`qoder-worker` 提供兼容别名。
- 由 Codex 从适用的项目说明、OpenSpec 产物、规格文件以及已安装 Codex Skill
  中提炼规则，生成上下文完整的委派 brief；Qoder 无需安装或理解这些 Skill。
- 渐进式 brief：简单任务只使用精简基础契约，仅在确有需要时加入项目上下文和
  专业规则。
- 三态 Brief Review（Spec）策略：支持显式 `required`、`off`，默认使用基于风险
  判断的 `auto`；Spec 模式用于预览委派 brief，不等同于生成 OpenSpec。
- 首次向外部 Qoder 外发数据及 Brief Review 在宿主支持结构化用户输入时优先使用
  卡片确认；不支持时回退为文本确认，且无需回复固定授权文案。
- 最窄工作目录和固定安全策略，禁止写出 `cwd`、处理凭证、发布内容以及执行
  Git 历史相关操作。
- 代码修改任务使用临时 detached worktree，可生成精确的 Qoder-only patch、独立
  审阅、执行冲突预检，并在应用到源 worktree 前等待明确批准。
- 使用 prompt 文件安全传递生成的或多行 brief，进行有界、文件身份校验的读取，
  不把 brief 插值进 shell 命令。
- 提供结构化结果 envelope、有界模型重试和输出、脱敏、超时、信号处理以及按平台
  终止进程树。
- 支持审查失败后原 worktree 修正、可信 Runner 失败原地恢复，以及关联 clean-restart
  session 清理，不依赖 Qoder 持久会话。

## 注意事项

- Codex 始终负责规划、上下文编译、审阅和最终验收；Qoder 是有边界的编码执行器，
  不是一个可自主扩展任务的对等会话。
- 代码修改的 worktree 隔离要求 Git 仓库已有 `HEAD` commit 且不存在 unmerged
  path；ignored 文件默认不可用，仓库根目录的 `.qoderinclude` 可显式快照本地存在的
  ignored 构建输入候选；该配置与文件都不是硬依赖。
- `cwd` 必须保持为真实写入范围的最窄边界。位于边界外的上下文应由 Codex 提炼进
  brief，不能为了让 Qoder 读取而扩大其可写范围。
- brief 审批只授权执行一次 Qoder 任务；把审阅后的 patch 应用到源 worktree 始终
  需要另一次明确批准。
- 本机必须已具备 Qoder 登录状态以及任务所需的 host/network 条件。执行失败时先停止，
  不得自动重试或扩大权限；外部条件修复并获得批准后，可信半成品应在原 prepared
  worktree 中继续。
- 不要在委派 brief 中加入凭证或秘密。生成的 brief 必须通过非 shell 文件写入工具
  创建，并使用 `--prompt-file` 传递。
- prompt 内容上限为 64 KiB；Windows 还可能因完整 `CreateProcessW` 命令行限制而
  具有更低的实际容量，Runner 会在启动 Qoder 前预检并返回 `invalid_input`。
- `qoder-worker` 依赖同目录安装的 `qoder-agent`；两个入口共用同一 Runner 和安全
  策略。

## 环境要求

- Node.js `>=22.18.0`
- pnpm `9.15.4` 或兼容的 pnpm 9 版本
- 已安装并完成登录的本地 Qoder CLI

请将 `qodercli` 加入 Codex 进程的 `PATH`，或通过 `QODERCLI_PATH`
（单次调用可用 `--qodercli-path`）配置其绝对路径。Runner 不会猜测某个用户主目录
下的安装位置。在 Windows 上必须配置原生 `qodercli.exe`；Runner 会拒绝
`qodercli.cmd`、`qodercli.bat` 等命令 shim，以便保持 `shell: false` 和参数边界。
Runner 会记录验证时使用的 Qoder 版本，但不会因版本不同而硬失败。

## 安装 Skill

项目级安装：

```sh
mkdir -p /path/to/project/.codex/skills
cp -R skill/qoder-agent /path/to/project/.codex/skills/qoder-agent
cp -R skill/qoder-worker /path/to/project/.codex/skills/qoder-worker
```

个人级安装：将两个目录复制到 `~/.codex/skills/` 或已配置的 Codex Skill 目录。
`qoder-worker` 是依赖同目录 `qoder-agent` 的兼容别名；请保留后者
`scripts/run_qoder.mjs` 的可执行权限。

## 运行 Runner

命令必须提供能覆盖预期改动的最窄绝对目录，以及有边界的任务 brief。请使用
非 shell 的编辑器或文件写入工具，把生成的或多行 brief 写入私有文件：

```sh
node skill/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/task-scope \
  --prompt-file /absolute/path/to/delegation-brief.md
```

内联 `--prompt` 仅为兼容保留；不得把生成的 brief 插值进 shell 命令。

可选参数为 `--qodercli-path`、`--model`、`--timeout-ms` 和
`--max-model-request-retries`，对应环境变量为 `QODERCLI_PATH`、
`QODER_MODEL`、`QODER_TIMEOUT_MS` 和 `QODER_MAX_MODEL_REQUEST_RETRIES`。
Runner 始终使用 `permission-mode auto`、JSON 输出、禁用会话持久化、参数数组启动、
有界模型重试和输出限制、脱敏、隐藏 Windows 子进程和按平台终止进程树。

默认超时时间为 30 分钟。如果用户显式说明委派任务是长任务，Skill 会为该次调用传入
`--timeout-ms 3600000`，将超时时间设为 1 小时，并把结果轮询从普通任务的外层
200 秒/内层 180 秒切换为外层 300 秒/内层 280 秒。

可通过 `$qoder-agent` 或 `$qoder-worker` 调用，两者使用同一个 Runner。请阅读
[skill/qoder-agent/SKILL.md](skill/qoder-agent/SKILL.md) 了解 Codex 协作
流程，阅读
[skill/qoder-agent/references/delegation-prompt.md](skill/qoder-agent/references/delegation-prompt.md)
了解由 Codex 编译上下文的 `Qoder Delegation Brief v1`，阅读
[skill/qoder-agent/references/worktree-review.md](skill/qoder-agent/references/worktree-review.md)
了解隔离审查、修正、恢复和应用生命周期，并阅读
[skill/qoder-agent/references/protocol.md](skill/qoder-agent/references/protocol.md)
了解结果 envelope。

## 隔离 worktree 生命周期

涉及代码修改的任务会使用临时 detached Git worktree。协调器镜像已跟踪和
non-ignored 的源码状态。仓库根目录的 `.qoderinclude` 可选择 OpenAPI schemas 等
本地 ignored 文件，在文件存在时于临时 worktree 中建立副本用于检查；它们不会进入 baseline、
审阅 patch 或源目录 apply。

`.qoderinclude` 使用仓库相对 glob：普通规则纳入，`!` 规则排除，最后匹配规则生效。
不存在的匹配、tracked 或 non-ignored 匹配以及本次 `cwd` 范围外的匹配会被安静跳过；
非空配置最终未匹配本地文件时仍会生成空 manifest。Git 负责高效枚举普通 ignored 文件，
协调器按 glob 结构定向扫描特殊文件，因此 `*.json`、`generated/*.ts` 和
`packages/*/generated/**` 等规则不需要额外的字面 ignored 根目录。快照上限为
20,000 个条目和
256 MiB；不安全链接、特殊文件、非法路径或超限选择都会使 `prepare` 失败。该配置只
声明项目依赖，不代表允许向 Qoder 披露密钥或无关本地数据。

session v2 使用记录的 SHA-256 和摘要验证 manifest，防止协调状态意外损坏；inspect、
审阅、reopen 与 apply 共用其排除集合。included ignored artifact 可以在临时 worktree
中变化，但 prepare 时登记的路径只作为本地检查输入，不能进入 Qoder-only patch 或源目录
apply。该校验采用协作式信任模型，不构成针对恶意 worker 的沙箱。

用户明确批准后，`apply` 会先检查并应用 Qoder 专属 patch，不会修改 source 的
Git index，应用成功后会自动删除临时 worktree 和 session。应用失败时会保留
session 供排查；如果 patch 已应用但清理失败，可重试
`dispose --state <statePath>`。只有放弃未应用的 session 时才使用
`dispose --state <statePath> --discard`。审查候选被拒绝时使用
`reopen --state <statePath>`，它会归档旧 patch 并保留完整 working tree 供后续修正。
可信 Runner 失败经检查和明确批准后也继续使用原 prepared worktree。只有明确要求
clean restart 或原 session 不可安全复用时，才在 `prepare` 中传入
`--retry-of <previous-statePath>`；成功 apply 后会清理关联 session 链。

## 开发检查

```sh
pnpm install
pnpm skill:check
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

维护源码位于 `packages/core` 和 `packages/cli` 的 TypeScript 文件中：`core`
负责可复用的 Runner 与 worktree 生命周期，`cli` 负责参数解析、进程信号、JSON
输出和退出码，并通过 `@qoder-agent-bridge/core` workspace package 引用 core。
TypeScript 源码统一使用 bundler 风格的无扩展名导入。`pnpm build` 会同时生成 package 产物，以及提交到
`skill/qoder-agent/scripts/` 的自包含 Skill 可执行文件。不要直接修改这些生成的
`.mjs` 文件。

## 可选真实验收

默认检查使用 fake child-process boundary，不会调用 Qoder 模型。如需显式执行端到端
验收，请在项目仓库之外创建临时仓库并手动创建 baseline commit。运行以下命令前，
请使用可信编辑器或非 shell 文件写入工具，在 fixture 外创建私有文件
`/absolute/path/to/qoder-verification-brief.md`，并写入有边界的验收任务：

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

如果 Qoder 返回权限拒绝、认证失败、超时或其他失败，停止并检查返回 envelope，
不要切换到其他权限模式重试。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
