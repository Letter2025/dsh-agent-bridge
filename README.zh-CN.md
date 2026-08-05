# Qoder Agent Bridge

[English](README.md)

通过 Skill 或 MCP 将 Qoder 接入你的 Agent 工作流。

当前仓库仅包含项目骨架和 Qoder 集成所需的基础配置。Qoder 运行器、MCP
服务器、协议行为以及正式测试均按约定保留为占位内容，留待后续里程碑实现。

## 环境要求

- Node.js `>=22.18.0`
- pnpm `9.15.4` 或兼容的 pnpm 9 版本

## 开发

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## 目录结构

- `skill/qoder-agent/` — 后续实现的可复用 Skill 和 Qoder 运行器。
- `packages/core/` — 计划供各集成复用的共享核心包。
- `packages/mcp-server/` — 后续实现的 MCP Server 包。
- `docs/` — 项目文档。
- `examples/` — 使用示例。
- `tests/` — 自动化测试。

## 当前状态

仅完成项目初始化。各预留目录中的占位文档记录了当前范围。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
