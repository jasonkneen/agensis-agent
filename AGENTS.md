# AGENTS.md

This repository is the open-source Agensis host agent. It does not contain the
Agensis website, backend, database, or desktop application.

## Layout

- `packages/agensis-cli/src` is the readable source of truth.
- `packages/agensis-agent` builds the published single-file npm bundle.
- `tests` contains Node and Vitest coverage for the daemon.

## Versioning

Keep these values identical for every release:

1. root `package.json` version
2. both package versions
3. `AGENSIS_CLI_VERSION` in `packages/agensis-cli/src/agensis.mjs`
4. `SOURCE_VERSION` in `packages/agensis-agent/build.mjs`
5. generated lockfile package versions

## Verification

Run `npm run verify`. Do not publish unless it passes and the generated bundle
reports the intended version through `node packages/agensis-agent/bin/agensis.mjs --version`.

## Release

Push a matching `agent-v<version>` tag. The publish workflow verifies the tag,
builds and packs the bundle, and publishes `@agensis/agensis-agent` using the
repository's `NPM_TOKEN` secret.
