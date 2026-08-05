# Qoder Agent Bridge

[简体中文](README.zh-CN.md)

Bridge Qoder into your agent workflow through Skills or MCP.

This repository currently contains the project skeleton and configuration for
the future Qoder integration. The Qoder runner, MCP server, protocol behavior,
and real tests are intentionally left as placeholders for a later milestone.

## Requirements

- Node.js `>=22.18.0`
- pnpm `9.15.4` or a compatible pnpm 9 release

## Development

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Repository layout

- `skill/qoder-agent/` — the future reusable Skill and Qoder runner.
- `packages/core/` — shared bridge primitives planned for reuse.
- `packages/mcp-server/` — the future MCP server package.
- `docs/` — project documentation.
- `examples/` — usage examples.
- `tests/` — automated tests.

## Status

Initialization only. See the placeholder documentation in each reserved
directory for the current scope.

## License

MIT. See [LICENSE](LICENSE).
