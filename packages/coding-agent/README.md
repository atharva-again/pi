# Pi

Pi is a minimal, extensible AI agent for the terminal. Adapt Pi to your workflow, not the other way around.

Ask Pi to create the prompt templates, skills, extensions, and themes you need, or install a Pi package. Use Pi directly, automate it in print, JSON, or RPC mode, or build applications with the TypeScript SDK.

This fork does not publish npm packages or binaries. The repository [README](../../README.md) describes fork-specific features; see the local [AGENTS.md](../../AGENTS.md) for development rules and the [coding-agent documentation](docs/index.md) for usage and API details.

This fork also provides `/refresh`, persistent session pinning in `/resume`,
forward and backward thinking-level controls, and the publishable OpenCode and
Codex session importer examples under `examples/extensions/`.

## Development

Run commands from the repository root. Install dependencies and start the fork using the instructions in the root [README](../../README.md).

Before validating changes, run:

```bash
npm run check
./test.sh
```

Read the repository's local [AGENTS.md](../../AGENTS.md) for implementation, testing, and dependency rules. This checkout is `atharva-again/pi`; it is not the upstream repository.

## License

MIT
