# Tests

Runner tests use a fake child-process boundary and never start the real Qoder
CLI. They cover argument construction, validation, executable/configuration
resolution, process-group termination, output bounds, redaction, envelopes,
and direct module import.

Run the complete deterministic suite with:

```sh
pnpm skill:check
```

Real Qoder verification is deliberately opt-in and belongs in a temporary
fixture outside the repository; see `examples/README.md`.
