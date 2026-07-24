---
name: fast-connection-executors
description: Rules for touching packages/agensis-cli/src/connectionExecutors.mjs or executor.mjs — the pooled Claude Agent SDK / codex app-server connections that keep one warm session per silo alive across jobs instead of spawning a subprocess per turn. Use this before adding a new option that affects how a session is opened (cwd, model, permissionMode, hostFolders, leanCli, mcp config), before touching the SDK pump loop or the codex JSON-RPC message handler, before changing idle-timeout or session-close logic, and before changing the "confirmedUnavailable" fallback-to-subprocess detection in createPrimaryExecutor. This subsystem pools long-lived state keyed by silo, so bugs here are stale-session or leaked-process bugs that only show up on a SECOND job, not the first.
---

# Fast connection executors (pooled Claude SDK / codex app-server)

`connectionExecutors.mjs` keeps ONE warm connection per silo (sessionKey =
workspace+handle) alive across many daemon jobs, instead of `cli.mjs`'s
LocalExecutor which spawns a fresh `claude`/`codex` process per job. Both
pooled executors and LocalExecutor implement the identical
`{status, stdout, stderr, error}` + `onData` contract so `executor.mjs`'s
`createPrimaryExecutor` can swap between them transparently (including
automatic fallback). Keep these rules in mind whenever editing either file:

## 1. Any new connection-affecting option MUST go into `connectionFingerprint()`

Sessions are reused only while `connectionFingerprint(opts)` stays identical
(see `ensureSession` in both executors: `if (session.fingerprint ===
fingerprint && !session.closed) return session`). If you add a new opt that
changes how the SDK `query()` or `codex app-server` `thread/start` is
configured — a new permission flag, a new MCP field, a new model param — and
forget to add it to `connectionFingerprint`, a job with the new value will
silently reuse a stale session built with the OLD value. This bug only shows
up on the *second* job for a silo, never the first (which always creates a
fresh session), so it's easy to miss in manual testing.

## 2. The SDK pump loop must never `break` the `for await`

`session.pump` in `createClaudeSdkExecutor` deliberately runs for the whole
session lifetime, not per turn: `for await (const message of query) { ... }`.
Breaking out of that loop (or letting an early `return` short-circuit it)
calls the async iterator's `return()`, which tears down the underlying
`claude` process. Turns are completed by calling `turn.finish(...)`, NOT by
exiting the loop — the loop keeps running to receive the *next* queued
message on the same process. If you add new message-type handling, add an
`else if` branch inside the existing loop; don't restructure it into a
per-turn `for await`.

## 3. Idle timers arm only after a turn fully settles

`armIdleTimer` is called after `run()` resolves successfully, and
`clearTimeout(session.idleTimer)` is called before starting a turn. If you
add a new early-return path out of `run()` (e.g. a new validation error),
make sure it goes through the same `finish()`/promise-resolution path so the
idle timer gets re-armed — an early return that skips `armIdleTimer` leaves
the session's timer cleared forever, so it never self-closes and the process
leaks for the life of the daemon.

## 4. `confirmedUnavailable` in `executor.mjs` is sticky for the whole process

`createPrimaryExecutor` remembers a family (`claude`/`codex`) as unavailable
the FIRST time an error matches `looksLikeUnavailable` (`Cannot find
module|ERR_MODULE_NOT_FOUND|ENOENT|command not found`), and every subsequent
job for that family goes straight to `LocalExecutor` for the rest of the
daemon's life — it never re-probes. If you add a new error path, make sure
its message doesn't accidentally match that regex unless it truly means "not
installed on this host" (e.g. don't let a transient ENOENT from an unrelated
file operation inside the SDK call propagate through this check — it will
permanently disable fast connections for that family until the daemon
restarts).

## 5. Concurrent jobs on one silo queue, they don't race

Both executors serialize `run()` calls sharing a `sessionKey` through
`createKeyedMutex()` (`withLock`). Don't add a code path that reads or
mutates `sessions.get(sessionKey)` outside of `run()`/`ensureSession()` — it
bypasses the mutex and can race with an in-flight turn on the same session.

## 6. `scrubbedChildEnv` must keep stripping secrets from the child process

Every executor that spawns a child process (`codex app-server`) or passes
`env` into the SDK's `query()` options routes it through
`scrubbedChildEnv`, which deletes `AGENSIS_TOKEN`, `ANTHROPIC_API_KEY`, and
`ANTHROPIC_AUTH_TOKEN` before merging with `process.env`. If you add a new
executor or a new place that builds a child env, reuse this helper rather
than hand-rolling the merge — these are the same secrets `agensis.mjs`
scrubs from the coding child elsewhere in the codebase.

## Where the tests live

`tests/agent-connection-executors.test.cjs` and `tests/agent-executor.test.cjs`
cover session reuse per `sessionKey`, per-silo isolation, and the
fallback-to-subprocess path — extend these rather than writing a new test
file when changing behavior here.
