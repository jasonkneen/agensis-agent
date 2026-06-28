'use strict';

// Agent Sandbox Execution — the Executor seam. LocalExecutor preserves today's
// behavior (spawn on the host); SandboxExecutor runs the same {cmd,args} inside a
// remote sandbox via an injected provider; createExecutor picks one by run_mode.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () =>
  import(pathToFileURL(path.resolve(__dirname, '../packages/agensis-cli/src/executor.mjs')).href);

test('LocalExecutor forwards opts to the runner and returns its result', async () => {
  const { createLocalExecutor } = await load();
  const seen = [];
  const fakeRun = async (opts) => { seen.push(opts); return { status: 0, stdout: 'ok', stderr: '', error: null }; };
  const ex = createLocalExecutor({ run: fakeRun });
  const res = await ex.run({ cmd: 'claude', args: ['-p', 'hi'], cwd: '/tmp' });
  assert.equal(res.stdout, 'ok');
  assert.equal(seen[0].cmd, 'claude');
  assert.deepEqual(seen[0].args, ['-p', 'hi']);
});

test('createExecutor picks LocalExecutor for builtin/daemon', async () => {
  const { createExecutor } = await load();
  const ex = createExecutor({ agent: { run_mode: 'daemon' } });
  assert.equal(typeof ex.run, 'function');
});

function fakeProvider(overrides = {}) {
  const calls = [];
  const p = {
    calls,
    ensureEnv: async () => { calls.push('ensureEnv'); return { id: 'sbx' }; },
    putRepo: async () => { calls.push('putRepo'); },
    exec: async (_h, { onData }) => { calls.push('exec'); onData?.('streamed '); onData?.('tokens'); return { status: 0, stdout: 'streamed tokens', stderr: '', error: null }; },
    getResult: async () => { calls.push('getResult'); return { patch: 'diff --git a b' }; },
    destroy: async () => { calls.push('destroy'); },
    ...overrides,
  };
  return p;
}

test('SandboxExecutor runs the provider lifecycle in order and folds the diff into stdout', async () => {
  const { createSandboxExecutor } = await load();
  const streamed = [];
  const p = fakeProvider();
  const ex = createSandboxExecutor(p);
  const res = await ex.run({ cmd: 'claude', args: ['-p', 'go'], onData: (c) => streamed.push(c) });
  assert.deepEqual(p.calls, ['ensureEnv', 'putRepo', 'exec', 'getResult', 'destroy']);
  assert.deepEqual(streamed, ['streamed ', 'tokens']);
  assert.match(res.stdout, /streamed tokens/);
  assert.match(res.stdout, /```diff\ndiff --git a b\n```/);
  assert.equal(res.status, 0);
});

test('SandboxExecutor forwards command environment through the provider seam', async () => {
  let received;
  const p = fakeProvider({
    exec: async (_handle, opts) => {
      received = opts;
      return { status: 0, stdout: '', stderr: '', error: null };
    },
  });
  const ex = (await load()).createSandboxExecutor(p);
  await ex.run({ cmd: 'codex', args: ['exec'], env: { AGENSIS_MCP_TOKEN: 'child-only' } });
  assert.deepEqual(received.env, { AGENSIS_MCP_TOKEN: 'child-only' });
});

test('SandboxExecutor always destroys the sandbox, even when exec throws', async () => {
  const { createSandboxExecutor } = await load();
  const p = fakeProvider({ exec: async () => { throw new Error('boom'); } });
  const ex = createSandboxExecutor(p);
  const res = await ex.run({ cmd: 'claude', args: [] });
  assert.ok(p.calls.includes('destroy'));
  assert.match(res.error.message, /boom/);
  assert.equal(res.status, null);
});

test('createExecutor builds a SandboxExecutor for run_mode sandbox using makeProvider', async () => {
  const { createExecutor } = await load();
  let built = 0;
  const provider = fakeProvider();
  const ex = createExecutor(
    { agent: { run_mode: 'sandbox', sandbox_provider: 'e2b', sandbox_config: {} } },
    { makeProvider: () => { built++; return provider; } },
  );
  await ex.run({ cmd: 'claude', args: [] });
  assert.equal(built, 1);
  assert.ok(provider.calls.includes('ensureEnv'));
});

test('nodeSupportsE2b gates on the e2b Node >=20.18.1 engine floor', async () => {
  const { nodeSupportsE2b } = await load();
  assert.equal(nodeSupportsE2b('18.19.0'), false);
  assert.equal(nodeSupportsE2b('20.18.0'), false);
  assert.equal(nodeSupportsE2b('20.18.1'), true);
  assert.equal(nodeSupportsE2b('20.19.0'), true);
  assert.equal(nodeSupportsE2b('22.0.0'), true);
  assert.equal(nodeSupportsE2b('21.0.0'), false);
  assert.equal(nodeSupportsE2b('21.7.0'), false);
  assert.equal(nodeSupportsE2b('24.16.0'), true);
});

test('createExecutor without a family (or an unrecognized one) still returns plain LocalExecutor', async () => {
  const { createExecutor } = await load();
  const ex = createExecutor({ agent: { run_mode: 'daemon' } }, { family: 'something-else' });
  assert.equal(typeof ex.run, 'function');
});

test('createPrimaryExecutor uses the pooled connection when it succeeds', async () => {
  const { createPrimaryExecutor } = await load();
  const pooled = { run: async (opts) => ({ status: 0, stdout: `pooled:${opts.prompt}`, stderr: '', error: null }) };
  const local = { run: async () => { throw new Error('should not run local'); } };
  const ex = createPrimaryExecutor('claude', { pooled, local });
  const res = await ex.run({ prompt: 'hi' });
  assert.equal(res.stdout, 'pooled:hi');
});

test('createPrimaryExecutor falls back to LocalExecutor when the pooled connection looks unavailable, and remembers it', async () => {
  const { createPrimaryExecutor } = await load();
  let pooledCalls = 0;
  const pooled = { run: async () => { pooledCalls += 1; return { status: null, stdout: '', stderr: '', error: new Error('Cannot find module @anthropic-ai/claude-agent-sdk') }; } };
  const localCalls = [];
  const local = { run: async (opts) => { localCalls.push(opts); return { status: 0, stdout: 'local-ran', stderr: '', error: null }; } };
  const ex = createPrimaryExecutor('claude', { pooled, local });

  const first = await ex.run({ prompt: 'a' });
  assert.equal(first.stdout, 'local-ran');
  const second = await ex.run({ prompt: 'b' });
  assert.equal(second.stdout, 'local-ran');

  // Confirmed-unavailable after the first failure: the pooled connection is
  // never retried on the second job, only LocalExecutor runs.
  assert.equal(pooledCalls, 1);
  assert.equal(localCalls.length, 2);
});

test('createPrimaryExecutor does NOT fall back for an ordinary job error (not an availability problem)', async () => {
  const { createPrimaryExecutor } = await load();
  const pooled = { run: async () => ({ status: 1, stdout: '', stderr: 'rate limited', error: new Error('rate_limit') }) };
  const local = { run: async () => { throw new Error('should not run local'); } };
  // A family key distinct from the earlier tests' 'claude' — confirmedUnavailable
  // is a module-level singleton Set, and the fallback test above deliberately
  // poisons 'claude' in it; reusing that key here would skip calling pooled.run()
  // entirely and fail this test for an unrelated reason.
  const ex = createPrimaryExecutor('claude-ordinary-error', { pooled, local });
  const res = await ex.run({ prompt: 'a' });
  assert.equal(res.status, 1);
  assert.match(res.error.message, /rate_limit/);
});
