---
name: sandbox-optional-dep-guard
description: Use when touching the e2b sandbox executor (executor.mjs's nodeSupportsE2b/createE2bProviderLazy, sandbox/e2b.mjs), adding another sandbox provider, or changing the daemon bundle's `external` list — this is a 10-commit saga (8722469, 409003c, 79663fd, ba08d52, e3f3af2, c488164, 7eb10a6, 10bc0db, e756c81, ecaffa7) of regressions from a Node-18 daemon depending on a Node-20.18.1+-only optional package. Skipping any one guard reintroduces one of those regressions.
---

# Sandbox optional-dep guard (e2b)

`run_mode: "sandbox"` runs a job inside an e2b Firecracker microVM
(`packages/agensis-cli/src/sandbox/e2b.mjs`, orchestrated by
`createSandboxExecutor` in `executor.mjs`). The daemon core supports Node
>=18, but `e2b`'s engine floor is `>=20.18.1 <21 || >=22` (Node 21 is
explicitly excluded) — and `e2b` is a large package only needed by the
minority of hosts that run Sandbox agents. That mismatch is what the whole
commit saga above is about. Four invariants keep it from regressing:

## 1. e2b must never be a top-level import, anywhere

- `sandbox/e2b.mjs` imports `e2b` **inside** `ensureEnv()`, not at module top
  level (see the file's own header comment — this is deliberate, not an
  oversight).
- `executor.mjs`'s `createE2bProviderLazy()` defers even importing
  `./sandbox/e2b.mjs` itself until first use, specifically so
  `import('./executor.mjs')` in unit tests never pulls e2b in.
- If you add a second sandbox provider, follow the same shape: no top-level
  `import` of the provider's SDK anywhere it could be reached by a daemon
  boot path or a plain unit-test import.

## 2. Check the Node version BEFORE importing e2b, not after

`npm`'s `engines` field is only a warning — e2b **installs fine on Node 18**
and then fails with a cryptic `MODULE_NOT_FOUND`/import error at runtime.
`nodeSupportsE2b(version = process.versions.node)` in `executor.mjs`
numerically parses major/minor/patch and must run first:

```js
if (!nodeSupportsE2b()) {
  throw new Error(`Sandbox execution requires Node >=20.18.1 (you have ${process.versions.node}). Upgrade Node to use Sandbox agents; Built-in and Remote daemon modes still work on Node 18.`);
}
```

Node 21 is a real trap here — it's numerically between 20 and 22 but is
**excluded** by e2b's engine range, so a naive `major >= 20` check is wrong.
`tests/agent-executor.test.cjs`'s `nodeSupportsE2b` test pins exactly this
(20.18.0 → false, 20.18.1 → true, 21.x → false, 22.0.0 → true). Changing the
version-gate logic without updating that test (or vice versa) is the bug to
watch for.

`sandbox/e2b.mjs` ALSO catches the import failure itself
(`ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`/`Cannot find package 'e2b'`) as a
second, independent layer — belt-and-suspenders in case something reaches
`ensureEnv()` without going through the executor's version gate first. Keep
both layers if you touch this path; removing either one turns a clear error
back into a raw stack trace for users on Node 18.

## 3. The daemon bundle must keep e2b (and its bundle-mates) external

`packages/agensis-agent/build.mjs`:

```js
external: ['ws', 'e2b', '@anthropic-ai/claude-agent-sdk'],
```

e2b is large and conditionally needed; the Claude Agent SDK ships
platform-specific native executables. Neither can be flattened into the
bundle. If esbuild's `external` list here loses `e2b`, the published
`agensis-agent` bundle either breaks (bundling native/platform-specific
internals) or silently balloons — this is what commit `7eb10a6` fixed
(578KB→76KB by moving e2b back external). `e2b` must stay listed as a real
**dependency** (not devDependency) in `packages/agensis-agent/package.json`
and `packages/agensis-cli/package.json` so it installs alongside the
published package for hosts that use Sandbox mode.

## 4. Verifying a change here

```bash
# e2b provider unit tests need the experimental module-mock flag (see root package.json's "test" script):
node --experimental-test-module-mocks --test tests/agent-sandbox-e2b.test.cjs
node --experimental-test-module-mocks --test tests/agent-executor.test.cjs
```

Running `tests/agent-sandbox-e2b.test.cjs` with plain `node --test` (no
flag) fails with `TypeError: test.mock.module is not a function` — that's a
missing-flag error, not a real regression; don't "fix" it by rewriting the
mocks.

## Non-goals / what NOT to change here

- `createSandboxExecutor`'s lifecycle (`ensureEnv -> putRepo -> exec ->
  getResult -> destroy`, always-destroy-on-throw) is unrelated to the
  optional-dep problem — that's generic executor plumbing, not part of this
  saga.
- `IS_SANDBOX=1` / `AGENSIS_ALLOW_ROOT_SKIP_PERMISSIONS=1` in `exec()` are
  about running Claude Code as root inside the VM, a separate concern from
  the dependency-guarding covered here.
