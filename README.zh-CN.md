# Qoder Agent Bridge

[English](README.md)

通过受边界约束的一次性 Codex Skill 将本机 Qoder 接入 Agent 工作流。
第一阶段包含可复用的 `qoder-agent` Skill 和本地 Qoder CLI Runner，以及用于
worker 式委派的兼容入口 `qoder-worker`；MCP、ACP、会话编排和会话续接不属于
本阶段范围。

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

命令必须提供绝对项目目录和有边界的任务提示词：

```sh
node skill/qoder-agent/scripts/run_qoder.mjs \
  --cwd /absolute/path/to/project \
  --prompt "实现指定改动并运行相关测试，不要提交或推送。"
```

可选参数为 `--qodercli-path`、`--model`、`--timeout-ms` 和
`--max-model-request-retries`，对应环境变量为 `QODERCLI_PATH`、
`QODER_MODEL`、`QODER_TIMEOUT_MS` 和 `QODER_MAX_MODEL_REQUEST_RETRIES`。
Runner 始终使用 `permission-mode auto`、JSON 输出、禁用会话持久化、参数数组启动、
有界模型重试和输出限制、脱敏、隐藏 Windows 子进程和按平台终止进程树。

可通过 `$qoder-agent` 或 `$qoder-worker` 调用，两者使用同一个 Runner。请阅读
[skill/qoder-agent/SKILL.md](skill/qoder-agent/SKILL.md) 了解 Codex 协作
流程，并阅读
[skill/qoder-agent/references/protocol.md](skill/qoder-agent/references/protocol.md)
了解结果 envelope。

## 隔离 worktree 生命周期

涉及代码修改的任务会使用临时 detached Git worktree。协调器只镜像已跟踪和
non-ignored 的源码状态；`node_modules` 等 ignored 依赖不会被复制、链接或安装。
用户明确批准后，`apply` 会先检查并应用 Qoder 专属 patch，不会修改 source 的
Git index，应用成功后会自动删除临时 worktree 和 session。应用失败时会保留
session 供排查；如果 patch 已应用但清理失败，可重试
`dispose --state <statePath>`。只有放弃未应用的 session 时才使用
`dispose --state <statePath> --discard`。如果要基于失败 session 发起新的尝试，
在 `prepare` 时传入 `--retry-of <previous-statePath>`。新尝试成功 apply 后会删除
当前 session 及其关联的前置 session；新尝试失败时则保留整条链。

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

Skill Runner 直接从 `skill/qoder-agent/` 执行；package 构建只覆盖现有 workspace
包，不会在 `dist/` 下生成第二份 Runner。

## 可选真实验收

默认检查使用 fake child-process boundary，不会调用 Qoder 模型。如需显式执行端到端
验收，请在项目仓库之外创建临时仓库并手动创建 baseline commit：

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
  --prompt "将 example.txt 增加一行，运行相关检查，不要 commit、push、publish、reset 或 clean。"

git -C "$fixture" status --short
git -C "$fixture" diff
git -C "$fixture" remote -v
```

如果 Qoder 返回权限拒绝、认证失败、超时或其他失败，停止并检查返回 envelope，
不要切换到其他权限模式重试。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
