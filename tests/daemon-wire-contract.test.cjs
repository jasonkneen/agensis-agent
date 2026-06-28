'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

test('daemon honors the hub auth, register, job, delta, and result contract', { timeout: 20_000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-wire-'));
  const fakeCli = path.join(tempDir, 'fake-cli.mjs');
  await fs.writeFile(fakeCli, '#!/usr/bin/env node\nprocess.stdout.write("wire-ok");\n', { mode: 0o700 });

  const server = new WebSocket.Server({ host: '::1', port: 0 });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const frames = [];
  let child;

  try {
    const resultFrame = new Promise((resolve, reject) => {
      server.once('connection', (socket, request) => {
        assert.match(request.url, /^\/backend\/ws\?workspaceId=workspace-wire&agentId=agent-wire$/);
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw));
          frames.push(frame);
          if (frames.length === 1) {
            assert.deepEqual(frame, { type: 'auth', token: 'aga_wire_token' });
          }
          if (frame.action === 'agent_register') {
            assert.equal(frames[0].type, 'auth');
            assert.equal(frame.workspaceId, 'workspace-wire');
            assert.equal(frame.agentId, 'agent-wire');
            assert.equal(frame.metadata.runtime, 'agensis');
            socket.send(JSON.stringify({
              type: 'agent_registered',
              connection: { name: 'wire-agent', host: 'test-host' },
              agent: { model: 'claude-opus-4-8', permission_mode: 'default' },
            }));
            socket.send(JSON.stringify({
              type: 'agent_job',
              job: {
                id: 'job-wire',
                workspaceId: 'workspace-wire',
                sessionId: 'session-wire',
                prompt: 'Reply through the wire contract.',
                agent: { model: 'claude-opus-4-8', permission_mode: 'default', run_mode: 'daemon' },
              },
            }));
          }
          if (frame.action === 'agent_job_result') resolve(frame);
        });
        socket.once('error', reject);
      });
    });

    child = spawn(process.execPath, [
      'packages/agensis-cli/bin/agensis.mjs',
      'connect',
      '--url', `http://[::1]:${port}`,
      '--token', 'aga_wire_token',
      '--workspace', 'workspace-wire',
      '--agent', 'agent-wire',
      '--handle', 'wire-agent',
      '--cwd', tempDir,
      '--coding-cmd', fakeCli,
      '--heartbeat-ms', '1000',
      '--once',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: tempDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExit = new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });

    const result = await resultFrame;
    assert.equal(result.jobId, 'job-wire');
    assert.equal(result.response, 'wire-ok');
    assert.equal(result.error, '');
    assert.ok(frames.some((frame) => frame.action === 'agent_job_delta' && frame.jobId === 'job-wire'));
    const exitCode = await childExit;
    assert.equal(exitCode, 0);
  } finally {
    if (child?.exitCode == null) child?.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
