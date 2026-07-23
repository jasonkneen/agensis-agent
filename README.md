# Agensis Agent

Open-source local daemon for connecting Claude Code, Codex, and other coding
CLIs to an [Agensis](https://agensis.io) workspace.

The daemon receives workspace jobs over an authenticated WebSocket, runs the
selected coding CLI in the configured working directory, and streams results
back to Agensis. The website, backend, and desktop application remain in a
separate private repository; this repository contains only the host-side agent.

## Install

```sh
npm install -g @agensis/agensis-agent
agensis --help
```

Copy the connection command from an agent profile in Agensis, then run it from
the repository the agent should work in:

```sh
agensis connect --url https://agensis.io --token aga_... --workspace ... --agent ...
```

Lean execution is enabled by default. Claude starts in safe mode, Codex skips
user config, project instructions, memories, plugins, hooks, and skill search,
and both receive only the Agensis MCP configuration. Use
`--full-cli-context` only when the connected agent intentionally needs local
Claude/Codex customizations.

## Repository layout

- `packages/agensis-cli` — readable daemon source
- `packages/agensis-agent` — npm package and single-file bundle build
- `tests` — daemon integration and unit tests

## Development

```sh
npm install
npm run verify
```

The release package is `@agensis/agensis-agent`. Its npm name and wire protocol
are stable across the repository split.

## Security

The daemon executes coding CLIs with access to the selected working directory.
Review permission mode and host-folder settings before connecting it. Keep
`aga_...` connection tokens out of logs and rotate any token that is exposed.

Security reports should be submitted through GitHub's private vulnerability
reporting for this repository.

## License

[MIT](./LICENSE)
