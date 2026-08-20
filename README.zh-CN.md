# DSH Agent Bridge

[English](README.md)

DSH Agent Bridge 将 Codex 与 DeepSeek Harness 组合成一个有边界的编码工作流：
Codex 负责规划、上下文编译、代码审阅和验收；DSH 负责在自己的永久任务 worktree
中编码，并在同一个 Web Session 中持续接收修复指令。

项目基于 MIT 许可的
[`lei233/qoder-agent-bridge`](https://github.com/lei233/qoder-agent-bridge)
改造，并针对 DSH Web RPC、持久会话以及
[`dsh-task-worktree`](https://github.com/Letter2025/dsh-task-worktree)
重新实现了工作区编排层。

## 默认工作流

```text
Codex 规划
  ↓
通过 DSH Web 创建 controller session
  ↓
DSH 执行 /worktree create <name>
  ↓
dsh-task-worktree 创建永久 worktree
  ↓
桥接器校验路径、分支和 base commit
  ↓
创建 cwd=worktree 的 worker session
  ↓
DSH 编码 ←→ Codex 审阅与修复指令
  ↓
用户批准
  ↓
DSH 执行 /worktree bring-back <name>
```

Codex 不会导入或直接调用 `dsh-task-worktree`。所有插件操作都通过 DSH Web 的
RPC 和 command registry 执行。

## 主要能力

- 复用同一个 DSH `workerSessionId`，保留对话和文件上下文。
- 使用 `dsh-task-worktree` 创建分支型永久 worktree。
- 仅连接 `127.0.0.1`、`localhost` 或 `::1` 上的 DSH Web。
- 校验 worktree 路径、Git 注册、分支、HEAD 和初始 clean 状态。
- 源工作区必须 clean；不要求 push，但完整基线必须存在于本地 `HEAD`。
- clean `HEAD` 的 `.gitignore` 必须包含 `.dsh-worktrees/`，避免插件准备阶段
  修改源工作区。
- Codex 独立检查 diff、未跟踪文件和测试结果。
- 最多两轮同范围 DSH 修复。
- bring-back 和 remove 始终需要单独用户批准。
- 保留原有 headless Runner 作为显式兼容模式。

## 环境要求

- Node.js `>=22.18.0`
- pnpm 9
- DeepSeek Harness `0.1.0-rc.7` 兼容版本
- Git 2.31+
- Web profile 中安装 `dsh-task-worktree`
- 已配置可用的 DSH 模型

安装插件并启动 Web profile：

```powershell
dsh plugin --profile web add dsh-task-worktree
dsh --profile web --no-open
```

默认 URL 为 `http://127.0.0.1:3080`。若端口不同，可设置 `DSH_WEB_URL` 或在命令中
传入 `--web-url`。

## 安装 Codex Skill

项目级安装：

```text
<project>/.codex/skills/dsh-agent/
<project>/.codex/skills/dsh-worker/
```

个人安装：将 `skill/dsh-agent` 和 `skill/dsh-worker` 复制到
`~/.codex/skills/`。

在 Codex 中使用：

```text
使用 $dsh-agent 完成这个任务。你负责规划和验收，让 DSH 创建永久 worktree，
在同一个 DSH Web Session 中实现和修复，验收通过后再向我申请 bring-back。
```

## Web 编排 CLI

创建插件 worktree 和持久 DSH Session：

```powershell
node skill/dsh-agent/scripts/dsh_web.mjs prepare `
  --cwd C:\absolute\project `
  --name codex/task-name
```

执行首轮编码或后续修复：

```powershell
node skill/dsh-agent/scripts/dsh_web.mjs run `
  --state C:\absolute\state.json `
  --prompt-file C:\absolute\delegation-brief.md
```

检查状态：

```powershell
node skill/dsh-agent/scripts/dsh_web.mjs inspect --state C:\absolute\state.json
node skill/dsh-agent/scripts/dsh_web.mjs status --state C:\absolute\state.json
```

用户明确批准后带回或删除：

```powershell
node skill/dsh-agent/scripts/dsh_web.mjs bring-back --state C:\absolute\state.json
node skill/dsh-agent/scripts/dsh_web.mjs remove --state C:\absolute\state.json
```

`--force` 只用于用户明确批准丢弃 dirty worktree 的 remove 操作。

## 安全边界

- Web Bridge 只接受 loopback HTTP URL。
- 编码 brief 发送给 DSH 模型前必须取得任务范围的数据授权。
- DSH 模型不得 commit、stage、push、发布、处理凭据或修改 DSH 配置。
- bring-back 是独立的 DSH command，可能创建 worktree commit 并合并到源分支。
- 不允许同时使用新版 Web worktree 和旧版临时 worktree coordinator。
- Web 模式不会携带源工作区未提交改动；dirty source 会直接失败。

## 开发检查

```powershell
pnpm install
pnpm skill:check
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

维护源码位于 `packages/core` 和 `packages/cli`。`pnpm build` 会重新生成
`skill/dsh-agent/scripts/` 下的独立可执行文件，请勿直接编辑生成的 `.mjs`。

## License

MIT，详见 [LICENSE](LICENSE)。
