'use strict';

// connectionExecutors.mjs — the "fast connection" executors. Both take an
// injected transport (queryFn / spawnFn) so these tests exercise the real
// session-pooling, NDJSON re-encoding, and streaming/result logic without
// touching a real `claude` process, a real `codex` binary, or the network.
// The codex app-server wire shapes asserted here (NDJSON {id,method,params}
// requests, {method,params} notifications, thread/start + turn/start +
// item/agentMessage/delta + turn/completed) were captured live against the
// installed codex-cli 0.145.0 `codex app-server` subcommand, not guessed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () =>
  import(pathToFileURL(path.resolve(__dirname, '../packages/agensis-cli/src/connectionExecutors.mjs')).href);

// --- Codex app-server fakes -------------------------------------------------

function fakeCodexChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  const writes = [];
  child.stdin = { write: (chunk) => writes.push(chunk) };
  child.kill = () => child.emit('exit', 0, null);
  child.writes = writes;
  child.send = (obj) => child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  return child;
}

// Replays the exact request/notification sequence captured from a live
// `codex app-server` run: initialize -> thread/start -> turn/start ack,
// then item/agentMessage/delta notifications, then turn/completed.
function scriptedCodexServer(child, {
  deltas = ['OK'],
  threadId = 'thread-1',
  turnId = 'turn-1',
  fail = false,
  approvalMethod = '',
} = {}) {
  let turnStarted = false;
  const seen = [];
  let approvalResponse = null;
  const emitTurn = () => {
    for (const delta of deltas) {
      child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'item-1', delta } });
    }
    if (fail) {
      child.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message: 'boom' } } } });
    } else {
      child.send({
        method: 'item/completed',
        params: { threadId, turnId, item: { type: 'agentMessage', id: 'item-1', text: deltas.join('') } },
      });
      child.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    }
  };
  const originalWrite = child.stdin.write;
  child.stdin.write = (chunk) => {
    originalWrite(chunk);
    seen.push(chunk);
    const { id, method, params } = JSON.parse(chunk);
    if (id === 'approval-1' && !method) {
      approvalResponse = JSON.parse(chunk);
      queueMicrotask(emitTurn);
      return;
    }
    if (method === 'initialize') {
      queueMicrotask(() => child.send({ id, result: { codexHome: '/tmp' } }));
    } else if (method === 'thread/start') {
      queueMicrotask(() => child.send({ id, result: { thread: { id: threadId } } }));
    } else if (method === 'turn/start') {
      queueMicrotask(() => {
        child.send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
        turnStarted = true;
        child.send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
        if (approvalMethod) {
          child.send({ id: 'approval-1', method: approvalMethod, params: { threadId, turnId, itemId: 'item-1' } });
        } else {
          emitTurn();
        }
      });
    } else if (method === 'turn/interrupt') {
      queueMicrotask(() => child.send({ id, result: {} }));
    }
  };
  return { seen, wasTurnStarted: () => turnStarted, approvalResponse: () => approvalResponse };
}

test('codex app-server executor: streams deltas and resolves stdout on turn/completed', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  scriptedCodexServer(child, { deltas: ['O', 'K'] });
  const spawnFn = () => child;
  const ex = createCodexAppServerExecutor({ spawnFn });

  const streamed = [];
  const result = await ex.run({
    cwd: '/tmp',
    prompt: 'say ok',
    sessionKey: 'silo-1',
    onData: (c) => streamed.push(c),
  });

  assert.deepEqual(streamed, ['O', 'K']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'OK');
  assert.equal(result.error, null);
  assert.deepEqual(
    child.writes.slice(0, 3).map((line) => JSON.parse(line).method),
    ['initialize', 'initialized', 'thread/start'],
  );
});

test('codex app-server executor: an automatic model defers to the Codex configuration', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  const server = scriptedCodexServer(child);
  const ex = createCodexAppServerExecutor({ spawnFn: () => child });

  await ex.run({
    cwd: '/tmp',
    prompt: 'use the configured model',
    model: '',
    sessionKey: 'silo-auto-model',
    onData: () => {},
  });

  const threadStart = server.seen
    .map((line) => JSON.parse(line))
    .find((message) => message.method === 'thread/start');
  assert.equal(Object.hasOwn(threadStart.params, 'model'), false);
});

test('codex app-server executor: an explicit model is sent to Codex', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  const server = scriptedCodexServer(child);
  const ex = createCodexAppServerExecutor({ spawnFn: () => child });

  await ex.run({
    cwd: '/tmp',
    prompt: 'use this model',
    model: 'gpt-5.6-sol',
    sessionKey: 'silo-explicit-model',
    onData: () => {},
  });

  const threadStart = server.seen
    .map((line) => JSON.parse(line))
    .find((message) => message.method === 'thread/start');
  assert.equal(threadStart.params.model, 'gpt-5.6-sol');
});

test('codex app-server executor: reuses one spawned process across jobs with the same sessionKey', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  scriptedCodexServer(child);
  let spawnCount = 0;
  const spawnFn = () => { spawnCount += 1; return child; };
  const ex = createCodexAppServerExecutor({ spawnFn });

  await ex.run({ cwd: '/tmp', prompt: 'first', sessionKey: 'silo-1', onData: () => {} });
  await ex.run({ cwd: '/tmp', prompt: 'second', sessionKey: 'silo-1', onData: () => {} });

  assert.equal(spawnCount, 1);
});

test('codex app-server executor: a different sessionKey gets its own process', async () => {
  const { createCodexAppServerExecutor } = await load();
  const spawned = [];
  const spawnFn = () => {
    const child = fakeCodexChild();
    scriptedCodexServer(child);
    spawned.push(child);
    return child;
  };
  const ex = createCodexAppServerExecutor({ spawnFn });

  await ex.run({ cwd: '/tmp', prompt: 'a', sessionKey: 'silo-a', onData: () => {} });
  await ex.run({ cwd: '/tmp', prompt: 'b', sessionKey: 'silo-b', onData: () => {} });

  assert.equal(spawned.length, 2);
});

test('codex app-server executor: turn/completed with a failed status surfaces as a result error', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  scriptedCodexServer(child, { fail: true });
  const ex = createCodexAppServerExecutor({ spawnFn: () => child });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, 1);
  assert.match(result.error.message, /boom/);
});

test('codex app-server executor: answers approval requests instead of leaving a remote job hung', async () => {
  const { createCodexAppServerExecutor } = await load();
  const child = fakeCodexChild();
  const server = scriptedCodexServer(child, { approvalMethod: 'item/fileChange/requestApproval' });
  const ex = createCodexAppServerExecutor({ spawnFn: () => child });

  const result = await ex.run({
    cwd: '/tmp',
    prompt: 'edit it',
    permissionMode: 'accept_edits',
    sessionKey: 'silo-1',
    onData: () => {},
  });

  assert.equal(result.status, 0);
  assert.deepEqual(server.approvalResponse(), { id: 'approval-1', result: { decision: 'acceptForSession' } });
});

test('codex app-server executor: a spawn failure (binary missing) resolves an error instead of throwing', async () => {
  const { createCodexAppServerExecutor } = await load();
  const spawnFn = () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); };
  const ex = createCodexAppServerExecutor({ spawnFn });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, null);
  assert.match(result.error.message, /ENOENT/);
});

// --- Claude Agent SDK fakes -------------------------------------------------

function fakeClaudeQuery({ deltas = ['OK'], finalResult = 'OK', subtype = 'success', resultFields = {} } = {}) {
  const pushed = [];
  let calls = 0;
  const queryFn = ({ prompt }) => {
    calls += 1;
    const gen = (async function* () {
      for await (const input of prompt) {
        pushed.push(input);
        const turn = pushed.length;
        const turnDeltas = typeof deltas === 'function' ? deltas(input, turn) : deltas;
        const turnResult = typeof finalResult === 'function' ? finalResult(input, turn) : finalResult;
        for (const text of turnDeltas) {
          yield { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
        }
        yield { type: 'result', subtype, result: subtype === 'success' ? turnResult : 'sdk error', session_id: 's1', ...resultFields };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  return { queryFn, pushed, calls: () => calls };
}

test('claude sdk executor: re-encodes deltas as stream-json NDJSON and resolves the authoritative result', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn } = fakeClaudeQuery({ deltas: ['O', 'K'], finalResult: 'OK' });
  const ex = createClaudeSdkExecutor({ queryFn });

  const lines = [];
  const result = await ex.run({ cwd: '/tmp', prompt: 'say ok', sessionKey: 'silo-1', onData: (c) => lines.push(c) });

  const parsed = lines.map((l) => JSON.parse(l.trim()));
  assert.deepEqual(parsed.filter((m) => m.type === 'stream_event').map((m) => m.event.delta.text), ['O', 'K']);
  assert.deepEqual(parsed.find((m) => m.type === 'result'), { type: 'result', result: 'OK' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'OK');
});

test('claude sdk executor: one query() session is created and reused for multiple jobs on the same sessionKey', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn, pushed, calls } = fakeClaudeQuery({
    deltas: (_input, turn) => [`turn-${turn}`],
    finalResult: (_input, turn) => `result-${turn}`,
  });
  const ex = createClaudeSdkExecutor({ queryFn });

  const first = await ex.run({ cwd: '/tmp', prompt: 'first', sessionKey: 'silo-1', onData: () => {} });
  const second = await ex.run({ cwd: '/tmp', prompt: 'second', sessionKey: 'silo-1', onData: () => {} });

  assert.equal(calls(), 1);
  assert.deepEqual(pushed.map((message) => message.message.content), ['first', 'second']);
  assert.equal(first.stdout, 'result-1');
  assert.equal(second.stdout, 'result-2');
});

test('claude sdk executor: a non-success result subtype surfaces as a result error, not a throw', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn } = fakeClaudeQuery({ subtype: 'rate_limit' });
  const ex = createClaudeSdkExecutor({ queryFn });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, 1);
  assert.ok(result.error);
});

test('claude sdk executor: SDK initialization failure resolves an error instead of throwing', async () => {
  const { createClaudeSdkExecutor } = await load();
  const ex = createClaudeSdkExecutor({ queryFn: () => { throw new Error('SDK initialization failed'); } });
  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-1', onData: () => {} });
  assert.equal(result.status, null);
  assert.match(result.error.message, /SDK initialization failed/);
});

test('claude sdk executor: timeout closes the session so late output cannot leak into the next job', async () => {
  const { createClaudeSdkExecutor } = await load();
  let callCount = 0;
  const queryFn = ({ prompt }) => {
    callCount += 1;
    const gen = (async function* () {
      for await (const _input of prompt) await new Promise(() => {});
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });

  const timedOut = await ex.run({
    cwd: '/tmp',
    prompt: 'never finishes',
    sessionKey: 'silo-1',
    timeoutMs: 10,
    onData: () => {},
  });

  assert.equal(timedOut.status, null);
  assert.match(timedOut.error.message, /timed out/);
  assert.equal(callCount, 1);
});

// The workspace's own MCP tools must be auto-approved in EVERY permission mode.
//
// Regression this pins: @scout on a remote VM had the agensis MCP connected and
// its tool schemas loaded, yet every mcp__agensis__create_task call came back
// "you haven't granted it yet". The daemon passed no allowedTools, so in the
// default permission mode the SDK asked for approval — and a headless daemon has
// nobody to ask. It could not be fixed with a settings file either: lean mode
// (the default) passes settingSources: [], so settings.local.json is never read
// and grants written there are silently ignored.
test('claude sdk executor: auto-allows the agensis MCP tools in the default permission mode', async () => {
  const { createClaudeSdkExecutor } = await load();
  let seen = null;
  const { queryFn } = fakeClaudeQuery({});
  const wrapped = (args) => { seen = args.options; return queryFn(args); };
  const ex = createClaudeSdkExecutor({ queryFn: wrapped });
  await ex.run({ cwd: '/tmp', prompt: 'hi', permissionMode: 'default' });

  assert.ok(Array.isArray(seen.allowedTools), 'allowedTools must be passed to the SDK');
  assert.ok(
    seen.allowedTools.includes('mcp__agensis'),
    `expected the agensis MCP server to be auto-allowed, got ${JSON.stringify(seen.allowedTools)}`,
  );
  // It is an exemption, not a restriction — the SDK documents `tools` for that.
  // If this ever becomes the whole tool set, the agent loses Read/Write/Bash.
  assert.equal(seen.tools, undefined, 'must not restrict the available tool set');
  assert.equal(seen.permissionMode, 'default', 'permission mode itself is unchanged');
});

test('claude sdk executor: still auto-allows the agensis MCP tools under yolo', async () => {
  const { createClaudeSdkExecutor } = await load();
  let seen = null;
  const { queryFn } = fakeClaudeQuery({});
  const ex = createClaudeSdkExecutor({ queryFn: (args) => { seen = args.options; return queryFn(args); } });
  await ex.run({ cwd: '/tmp', prompt: 'hi', permissionMode: 'yolo' });
  assert.ok(seen.allowedTools.includes('mcp__agensis'));
  assert.equal(seen.permissionMode, 'bypassPermissions');
});

// Tool-only turns used to be invisible: the pump handled ONLY stream_event text
// deltas and result, so while the agent read files, grepped, ran bash or spawned
// subagents no text existed, no delta was sent, and the chat sat on "Thinking …"
// in silence. tool_use blocks live on assistant messages, which were ignored.
test('claude sdk executor: emits one agensis_step per tool_use block without duplicating reply text', async () => {
  const { createClaudeSdkExecutor } = await load();
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield {
          type: 'assistant',
          session_id: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me look.' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/App.tsx' } },
              { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'npm test\n--watch=false' } },
            ],
          },
        };
        yield { type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } };
        yield { type: 'result', subtype: 'success', result: 'Done.', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });

  const lines = [];
  const result = await ex.run({ cwd: '/tmp', prompt: 'check it', sessionKey: 'silo-step', onData: (c) => lines.push(c) });
  const parsed = lines.map((l) => JSON.parse(l.trim()));

  assert.deepEqual(parsed.filter((m) => m.type === 'agensis_step').map((m) => m.step), [
    { kind: 'tool', name: 'Read', detail: 'src/App.tsx' },
    { kind: 'tool', name: 'Bash', detail: 'npm test --watch=false' },
  ]);
  // The assistant message's own text must NOT be re-emitted as a delta — it
  // already arrived via stream_event, and doubling it would double the reply.
  assert.deepEqual(parsed.filter((m) => m.type === 'stream_event').map((m) => m.event.delta.text), ['Done.']);
  assert.equal(result.stdout, 'Done.');
});

test('claude sdk executor: tool_use with no summarizable input still reports the tool name', async () => {
  const { createClaudeSdkExecutor } = await load();
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'TodoWrite' }] } };
        yield { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: 'not an array' } };
        yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });
  const lines = [];
  await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-step-2', onData: (c) => lines.push(c) });
  const steps = lines.map((l) => JSON.parse(l.trim())).filter((m) => m.type === 'agensis_step');
  assert.deepEqual(steps.map((m) => m.step), [{ kind: 'tool', name: 'TodoWrite', detail: '' }]);
});

// A turn is [text][tool][text][tool][text], but the whole turn's text used to
// land in ONE growing placeholder message — five separate thoughts run together
// in a single bubble, with nowhere for the human to read or steer between them.
// The segment closes each completed text block so the server can start the next
// message; it is emitted BEFORE that block's steps because that is the order the
// model produced them.
test('claude sdk executor: emits a segment per assistant text block, ahead of that block’s steps', async () => {
  const { createClaudeSdkExecutor } = await load();
  const delta = (text) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield delta('Only used here.');
        yield {
          type: 'assistant',
          session_id: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Only used here.' },
              { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: 'ChatWindowContent.tsx' } },
            ],
          },
        };
        yield delta('Now the dialog.');
        yield { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'Now the dialog.' }] } };
        yield { type: 'result', subtype: 'success', result: 'Now the dialog.', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });

  const lines = [];
  const result = await ex.run({ cwd: '/tmp', prompt: 'edit it', sessionKey: 'silo-segment', onData: (c) => lines.push(c) });
  const parsed = lines.map((l) => JSON.parse(l.trim()));

  // The whole wire, in order — text, then the tool that text announced, then the
  // next text. Each block's text crosses the wire exactly twice by design: as
  // live deltas and as the one authoritative segment that closes it.
  assert.deepEqual(parsed.map((m) => (
    m.type === 'agensis_segment' ? `segment:${m.segment.text}`
      : m.type === 'agensis_step' ? `step:${m.step.name}`
        : m.type === 'stream_event' ? `delta:${m.event.delta.text}`
          : `result:${m.result}`
  )), [
    'delta:Only used here.',
    'segment:Only used here.',
    'step:Edit',
    'delta:Now the dialog.',
    'segment:Now the dialog.',
    'result:Now the dialog.',
  ]);
  assert.equal(result.stdout, 'Now the dialog.');
});

// Closing a block resets the buffer for the next one, so the fallback has to
// bank what it closed — otherwise a turn whose result carries no text would
// resolve to just its last block, silently losing everything before it.
test('claude sdk executor: a result with no text still resolves to every block the turn wrote', async () => {
  const { createClaudeSdkExecutor } = await load();
  const delta = (text) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield delta('First block. ');
        yield { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'First block. ' }] } };
        yield delta('Second block.');
        yield { type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text: 'Second block.' }] } };
        yield { type: 'result', subtype: 'success', result: null, session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });
  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-segment-2', onData: () => {} });
  assert.equal(result.stdout, 'First block. Second block.');
});

test('summarizeToolInput: one short line from the first useful key, never the whole input', async () => {
  const { summarizeToolInput } = await load();
  assert.equal(summarizeToolInput({ file_path: 'a/b.ts', old_string: 'secret' }), 'a/b.ts');
  assert.equal(summarizeToolInput({ pattern: 'TODO', path: 'src' }), 'src'); // path outranks pattern
  assert.equal(summarizeToolInput({ prompt: 'line one\nline two' }), 'line one line two');
  assert.equal(summarizeToolInput({}), '');
  assert.equal(summarizeToolInput(undefined), '');
  assert.equal(summarizeToolInput({ command: 'x'.repeat(500) }).length, 121); // 120 chars + ellipsis
});

// A reasoning model on a long tool sweep narrates in `thinking` blocks, not
// `text` blocks. The assistant handler filtered on `type === "text"`, so all of
// it hit the floor: Jason watched a 14-tool run produce 14 chips and not one
// word of explanation, and asked "you're telling me there's NOTHING BEING SAID
// IN BETWEEN?". There was — the daemon threw it away. Tool RESULTS were dropped
// the same way: the pump had no `user` branch, and `user` is the SDK message
// type that carries tool_result back, so every chip said what was called and
// never whether it worked.
test('claude sdk executor: surfaces thinking and tool results, interleaved in model order', async () => {
  const { createClaudeSdkExecutor } = await load();
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield {
          type: 'assistant',
          session_id: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I need to find where\n  permissions are checked.' },
              { type: 'tool_use', id: 'tu_1', name: 'Grep', input: { pattern: 'canUseTool' } },
            ],
          },
        };
        yield {
          type: 'user',
          session_id: 's1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '3 matches' }] }],
          },
        };
        yield {
          type: 'assistant',
          session_id: 's1',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Found it. Now read the file.' },
              { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: 'a.mjs' } },
            ],
          },
        };
        yield {
          type: 'user',
          session_id: 's1',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'ENOENT' }],
          },
        };
        yield { type: 'result', subtype: 'success', result: 'done', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });

  const lines = [];
  await ex.run({ cwd: '/tmp', prompt: 'go', sessionKey: 'silo-thinking', onData: (c) => lines.push(c) });
  const steps = lines.map((l) => JSON.parse(l.trim()))
    .filter((m) => m.type === 'agensis_step')
    .map((m) => `${m.step.kind}:${m.step.name}:${m.step.detail}`);

  // Think, call, result, think, call, result — narration keeps its place next to
  // the call it introduces, rather than being batched ahead of every tool.
  // A SUCCESSFUL result raises no chip: the server persists only name/detail and
  // hardcodes message_kind='tool_step', so a success chip is indistinguishable
  // from the call and merely doubles the strip (0.1.41 shipped that and it read
  // as "17 tool calls and not a word said"). A FAILURE still earns a row —
  // that is the half a reader cannot infer from the call itself.
  assert.deepEqual(steps, [
    'thinking:Thinking:I need to find where permissions are checked.',
    'tool:Grep:canUseTool',
    'thinking:Thinking:Found it. Now read the file.',
    'tool:Read:a.mjs',
    'tool_result:Read:Failed: ENOENT',
  ]);
});

test('claude sdk executor: a thinking block with nothing in it raises no chip', async () => {
  const { createClaudeSdkExecutor } = await load();
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const _input of prompt) {
        yield {
          type: 'assistant',
          session_id: 's1',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '   \n  ' }] },
        };
        yield { type: 'result', subtype: 'success', result: 'done', session_id: 's1' };
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });
  const lines = [];
  await ex.run({ cwd: '/tmp', prompt: 'go', sessionKey: 'silo-empty-think', onData: (c) => lines.push(c) });
  assert.equal(lines.map((l) => JSON.parse(l.trim())).filter((m) => m.type === 'agensis_step').length, 0);
});

test('summarizeThinking / summarizeToolResult collapse and cap their prose', async () => {
  const { summarizeThinking, summarizeToolResult } = await load();
  assert.equal(summarizeThinking('a\n\n  b\tc '), 'a b c');
  assert.equal(summarizeThinking(''), '');
  assert.equal(summarizeThinking(undefined), '');
  assert.equal(summarizeThinking('x'.repeat(300)).length, 241, 'capped at 240 + ellipsis');
  assert.ok(summarizeThinking('x'.repeat(300)).endsWith('…'));
  // A plain string body is as valid as a block array.
  assert.equal(summarizeToolResult({ content: 'two  lines\nhere' }), 'two lines here');
  assert.equal(summarizeToolResult({ content: 'boom', is_error: true }), 'Failed: boom');
  assert.equal(summarizeToolResult({ content: '', is_error: true }), 'Failed');
  assert.equal(summarizeToolResult({ content: '' }), '');
  assert.equal(summarizeToolResult(null), '');
});

// Narration lives in `thinking` blocks, so the strip is empty unless the SDK is
// asked for them. Adaptive is already the default on capable models; pinning it
// means a future default of 'disabled' can't silently empty the strip again.
test('claude sdk executor: asks the SDK for adaptive thinking', async () => {
  const { createClaudeSdkExecutor } = await load();
  let seen = null;
  const { queryFn } = fakeClaudeQuery({});
  const ex = createClaudeSdkExecutor({ queryFn: (args) => { seen = args.options; return queryFn(args); } });
  await ex.run({ cwd: '/tmp', prompt: 'hi', sessionKey: 'silo-thinking-opt' });
  assert.deepEqual(seen.thinking, { type: 'adaptive' });
});

// --- Structured stop reasons and the two deadlines ---------------------------
//
// Everything below drives the REAL createClaudeSdkExecutor rather than the pure
// mapper in stopReasons.mjs (which has its own vitest suite). The point of these
// is the wiring: the SDK's terminal fields used to be read and thrown away one
// line later, and no unit test of a mapper can catch that.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Claude SDK fake whose turns do NOT end on their own. Messages are pushed in
 * by the test, so a turn can be held open to exercise silence, cancellation and
 * the post-interrupt drain — none of which are reachable with a generator that
 * always yields a result.
 */
function manualClaudeQuery() {
  const pushed = [];
  const interrupts = [];
  let calls = 0;
  let outbox = [];
  let waiting = null;

  const emit = (message) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: message, done: false });
    } else {
      outbox.push(message);
    }
  };

  const closes = [];
  const queryFn = ({ prompt }) => {
    calls += 1;
    outbox = [];
    void (async () => { for await (const input of prompt) pushed.push(input); })();
    let closed = false;
    const gen = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (outbox.length) return Promise.resolve({ value: outbox.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiting = resolve; });
        },
      }),
    };
    gen.interrupt = async () => { interrupts.push(Date.now()); };
    gen.close = () => {
      closes.push(Date.now());
      closed = true;
      if (waiting) { const resolve = waiting; waiting = null; resolve({ value: undefined, done: true }); }
    };
    return gen;
  };

  return { queryFn, emit, pushed, interrupts, closes, calls: () => calls };
}

test('claude sdk executor: a failed result reports WHY, not just that it failed', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn } = fakeClaudeQuery({ subtype: 'error_max_turns' });
  const ex = createClaudeSdkExecutor({ queryFn });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-stop-1', onData: () => {} });

  assert.equal(result.status, 1);
  assert.equal(result.stop.reason, 'max_turns');
  assert.equal(result.stop.detail, 'error_max_turns');
});

test('claude sdk executor: a successful result carries its terminal reason, turns and cost', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn } = fakeClaudeQuery({
    resultFields: {
      terminal_reason: 'budget_exhausted',
      num_turns: 5,
      total_cost_usd: 1.25,
      permission_denials: [{ tool_name: 'Bash' }],
      usage: { input_tokens: 10 },
    },
  });
  const ex = createClaudeSdkExecutor({ queryFn });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-stop-2', onData: () => {} });

  assert.equal(result.status, 0);
  assert.equal(result.stop.reason, 'max_budget');
  assert.equal(result.stop.numTurns, 5);
  assert.equal(result.stop.costUsd, 1.25);
  assert.equal(result.stop.permissionDenials, 1);
  assert.deepEqual(result.stop.usage, { input_tokens: 10 });
});

test('claude sdk executor: a turn that goes SILENT stops on the idle deadline, and activity rearms it', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn, emit, interrupts } = manualClaudeQuery();
  const ex = createClaudeSdkExecutor({ queryFn, cancelDrainMs: 20 });

  const seen = [];
  const running = ex.run({
    cwd: '/tmp', prompt: 'x', sessionKey: 'silo-idle-1', onData: (chunk) => seen.push(chunk),
    // The hard ceiling is far away: whatever stops this turn, it is not that.
    idleTimeoutMs: 60, timeoutMs: 10_000,
  });

  // Three ticks of activity spaced INSIDE the idle window. Each one has to push
  // the deadline out, or the turn dies during this loop and the later deltas
  // never reach onData.
  for (let i = 0; i < 3; i += 1) {
    await sleep(35);
    emit({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } } });
  }

  const result = await running;

  assert.equal(result.stop.reason, 'idle_timeout');
  // Survived ~105ms on a 60ms idle deadline: proof the deltas rearmed it.
  assert.equal(seen.length, 3);
  assert.equal(interrupts.length, 1, 'the idle deadline interrupts the runtime');
});

test('claude sdk executor: the hard ceiling still fires for a turn that never goes idle', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn, emit } = manualClaudeQuery();
  const ex = createClaudeSdkExecutor({ queryFn, cancelDrainMs: 20 });

  const running = ex.run({
    cwd: '/tmp', prompt: 'x', sessionKey: 'silo-hard-1', onData: () => {},
    // Chattering constantly, so the idle deadline can never fire — only the
    // absolute ceiling can end this.
    idleTimeoutMs: 60, timeoutMs: 120,
  });
  const chatter = setInterval(() => {
    emit({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } } });
  }, 15);

  const result = await running;
  clearInterval(chatter);

  assert.equal(result.stop.reason, 'hard_timeout');
});

test('claude sdk executor: a cancelled turn whose runtime settles KEEPS the warm session', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn, emit, calls, interrupts } = manualClaudeQuery();
  const ex = createClaudeSdkExecutor({ queryFn, cancelDrainMs: 500 });
  const controller = new AbortController();

  const running = ex.run({
    cwd: '/tmp', prompt: 'first', sessionKey: 'silo-drain-keep', onData: () => {}, signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  const result = await running;

  assert.equal(result.aborted, true);
  assert.equal(result.stop.reason, 'cancelled');
  assert.equal(interrupts.length, 1);

  // The runtime acknowledges the interrupt by settling the abandoned turn. That
  // is the evidence the connection is idle and reusable.
  emit({ type: 'result', subtype: 'success', result: '', session_id: 's1' });
  await sleep(30);

  const secondRun = ex.run({ cwd: '/tmp', prompt: 'second', sessionKey: 'silo-drain-keep', onData: () => {} });
  await sleep(20);
  emit({ type: 'result', subtype: 'success', result: 'second', session_id: 's1' });
  const second = await secondRun;

  assert.equal(second.stdout, 'second');
  assert.equal(calls(), 1, 'the session was reused rather than rebuilt after the cancel');
});

test('claude sdk executor: a cancelled turn whose runtime never settles tears the session down', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn, emit, calls, closes } = manualClaudeQuery();
  const ex = createClaudeSdkExecutor({ queryFn, cancelDrainMs: 30 });
  const controller = new AbortController();

  const running = ex.run({
    cwd: '/tmp', prompt: 'first', sessionKey: 'silo-drain-drop', onData: () => {}, signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  await running;

  // Nothing is emitted: the runtime is wedged.
  assert.equal(closes.length, 0, 'the session is still open while the drain is watching');
  await sleep(90);
  // The drain expired on its OWN — no second job was needed to notice. Asserting
  // this before the next run matters: ensureSession would also close an
  // un-settled session, so without this line the test passes even with the
  // drain's give-up removed entirely.
  assert.equal(closes.length, 1, 'an expired drain tears the session down by itself');

  const secondRun = ex.run({ cwd: '/tmp', prompt: 'second', sessionKey: 'silo-drain-drop', onData: () => {} });
  await sleep(20);
  emit({ type: 'result', subtype: 'success', result: 'second', session_id: 's1' });
  const second = await secondRun;

  assert.equal(second.stdout, 'second');
  assert.equal(calls(), 2, 'a wedged session is replaced, not handed to the next job');
});

test('claude sdk executor: a job arriving MID-drain never inherits the interrupted session', async () => {
  const { createClaudeSdkExecutor } = await load();
  const { queryFn, emit, calls } = manualClaudeQuery();
  // A long drain window, so the second job genuinely lands while it is open.
  const ex = createClaudeSdkExecutor({ queryFn, cancelDrainMs: 5_000 });
  const controller = new AbortController();

  const running = ex.run({
    cwd: '/tmp', prompt: 'first', sessionKey: 'silo-drain-race', onData: () => {}, signal: controller.signal,
  });
  await sleep(20);
  controller.abort();
  await running;

  // No settle: the first turn may still be streaming. Whatever it emits must not
  // land in the next conversation.
  const secondRun = ex.run({ cwd: '/tmp', prompt: 'second', sessionKey: 'silo-drain-race', onData: () => {} });
  await sleep(20);
  emit({ type: 'result', subtype: 'success', result: 'second', session_id: 's1' });
  const second = await secondRun;

  assert.equal(second.stdout, 'second');
  assert.equal(calls(), 2, 'an un-settled session is rebuilt rather than shared across turns');
});

test('claude sdk executor: a connection that dies under a live turn reports connection_lost', async () => {
  const { createClaudeSdkExecutor } = await load();
  const queryFn = ({ prompt }) => {
    const gen = (async function* () {
      for await (const input of prompt) {
        void input;
        return; // the SDK stream ends underneath the turn
      }
    })();
    gen.interrupt = async () => {};
    return gen;
  };
  const ex = createClaudeSdkExecutor({ queryFn });

  const result = await ex.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'silo-lost-1', onData: () => {} });

  assert.equal(result.stop.reason, 'connection_lost');
});

test('codex app-server executor: turn/completed carries a stop reason for both outcomes', async () => {
  const { createCodexAppServerExecutor } = await load();

  const okChild = fakeCodexChild();
  scriptedCodexServer(okChild, { deltas: ['hi'] });
  const okEx = createCodexAppServerExecutor({ spawnFn: () => okChild });
  const ok = await okEx.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'codex-stop-ok', onData: () => {} });
  assert.equal(ok.stop.reason, 'completed');

  const badChild = fakeCodexChild();
  scriptedCodexServer(badChild, { deltas: ['hi'], fail: true });
  const badEx = createCodexAppServerExecutor({ spawnFn: () => badChild });
  const bad = await badEx.run({ cwd: '/tmp', prompt: 'x', sessionKey: 'codex-stop-bad', onData: () => {} });
  assert.equal(bad.stop.reason, 'agent_error');
});
