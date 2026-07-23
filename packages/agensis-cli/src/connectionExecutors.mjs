// packages/agensis-cli/src/connectionExecutors.mjs
//
// "Fast connection" executors: instead of spawning a brand-new `claude -p` or
// `codex exec` process for every single job (today's LocalExecutor path in
// cli.mjs), these keep ONE warm connection per silo (workspace+handle) alive
// across jobs and reuse it:
//   - Claude: @anthropic-ai/claude-agent-sdk's query() in streaming-input mode.
//     The SDK still launches the `claude` CLI under the hood (confirmed by
//     reading sdk.mjs — it spawns cli.js/the native binary), but streaming
//     input keeps that ONE process alive and fed across turns instead of a
//     fresh boot per job, and gives typed SDKMessage events instead of a
//     hand-rolled NDJSON parser.
//   - Codex: `codex app-server` over its stdio JSON-RPC protocol (verified
//     live against installed codex-cli 0.145.0: NDJSON-framed
//     {id,method,params} requests / {id,result} responses / {method,params}
//     notifications). One thread/start per silo is reused for many
//     turn/start calls, skipping the several-second MCP-server-startup and
//     hook-registration cost `codex exec` repeats on every invocation.
//
// Both executors implement the same {status,stdout,stderr,error} + onData
// contract as runCli (cli.mjs) so createExecutor can swap them in without
// changing runAgentJob's result handling. Session state lives in
// module-level pools so it survives across daemon jobs for the process
// lifetime; idle sessions self-close after idleCloseMs.

import { spawn } from "node:child_process";

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;

function scrubbedChildEnv(env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.AGENSIS_TOKEN;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  return childEnv;
}

/** Minimal push-based async-iterable queue, used to feed streaming input. */
class PushQueue {
  #values = [];
  #resolvers = [];
  #closed = false;

  push(value) {
    if (this.#closed) return;
    const resolver = this.#resolvers.shift();
    if (resolver) resolver({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const resolver of this.#resolvers.splice(0)) resolver({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#values.length) return Promise.resolve({ value: this.#values.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#resolvers.push(resolve));
      },
    };
  }
}

/** Serializes async calls sharing a key so concurrent jobs on one silo queue instead of racing the same connection. */
function createKeyedMutex() {
  const tails = new Map();
  return (key, fn) => {
    const tail = (tails.get(key) || Promise.resolve()).then(fn, fn);
    tails.set(key, tail.catch(() => {}));
    return tail;
  };
}

function mapClaudePermission(permissionMode) {
  if (permissionMode === "yolo") return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  if (permissionMode === "accept_edits") return { permissionMode: "acceptEdits" };
  return { permissionMode: "default" };
}

function textFromStreamEvent(event) {
  if (!event || event.type !== "content_block_delta") return "";
  const delta = event.delta;
  return delta && delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

// runAgentJob (agensis.mjs) feeds onData chunks through createStreamJsonParser,
// which expects `claude --output-format stream-json` NDJSON lines — that's the
// shape LocalExecutor's raw subprocess stdout is in. This executor's onData
// deltas are plain SDK text, not NDJSON, so re-encode them into the same
// {type,event/result} shape the parser already knows how to read. That keeps
// the parser reusable unmodified across BOTH the subprocess path and this
// pooled path (including the automatic fallback between them), instead of
// forking runAgentJob's streaming logic per executor.
function encodeStreamJsonDelta(text) {
  return `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } })}\n`;
}
function encodeStreamJsonResult(result) {
  return `${JSON.stringify({ type: "result", result })}\n`;
}

function connectionFingerprint(opts) {
  return JSON.stringify({
    cwd: opts.cwd || "",
    model: opts.model || "",
    permissionMode: opts.permissionMode || "default",
    hostFolders: [...(opts.hostFolders || [])].sort(),
    leanCli: !!opts.leanCli,
    mcpUrl: opts.mcp?.url || "",
    mcpToken: opts.mcp?.env?.AGENSIS_MCP_TOKEN || "",
  });
}

/**
 * @param {{ queryFn?: Function, idleCloseMs?: number }} [opts]
 */
export function createClaudeSdkExecutor({ queryFn, idleCloseMs = DEFAULT_IDLE_CLOSE_MS } = {}) {
  const sessions = new Map(); // sessionKey -> one long-lived SDK query + input queue
  const withLock = createKeyedMutex();

  const closeSession = (sessionKey, expectedSession, activeResult) => {
    const session = sessions.get(sessionKey);
    if (!session || (expectedSession && session !== expectedSession)) return;
    sessions.delete(sessionKey);
    clearTimeout(session.idleTimer);
    session.closed = true;
    session.queue.close();
    if (activeResult && session.activeTurn) session.activeTurn.finish(activeResult);
    if (typeof session.query.close === "function") {
      try { session.query.close(); } catch { /* already closed */ }
    } else {
      Promise.resolve(session.query.return?.()).catch(() => {});
    }
  };

  const armIdleTimer = (sessionKey) => {
    const session = sessions.get(sessionKey);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => closeSession(sessionKey), idleCloseMs);
    session.idleTimer.unref?.();
  };

  const ensureSession = async (sessionKey, opts) => {
    let session = sessions.get(sessionKey);
    const fingerprint = connectionFingerprint(opts);
    if (session && session.fingerprint === fingerprint && !session.closed) return session;
    if (session) closeSession(sessionKey, session);
    if (!queryFn) {
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      queryFn = mod.query;
    }
    const queue = new PushQueue();
    const permission = mapClaudePermission(opts.permissionMode);
    const mcpServers = opts.leanCli && opts.mcp
      ? { agensis: { type: "http", url: opts.mcp.url, headers: { Authorization: "Bearer ${AGENSIS_MCP_TOKEN}" } } }
      : undefined;
    const query = queryFn({
      prompt: queue,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        ...permission,
        additionalDirectories: opts.hostFolders && opts.hostFolders.length ? opts.hostFolders : undefined,
        mcpServers,
        strictMcpConfig: opts.leanCli ? true : undefined,
        settingSources: opts.leanCli ? [] : undefined,
        persistSession: opts.leanCli ? false : undefined,
        includePartialMessages: true,
        env: scrubbedChildEnv(opts.mcp?.env),
      },
    });
    session = {
      query,
      queue,
      sessionId: "",
      idleTimer: null,
      activeTurn: null,
      closed: false,
      terminalError: null,
      fingerprint,
    };
    sessions.set(sessionKey, session);

    // This pump deliberately lives for the whole session. A `break` inside a
    // per-turn `for await` calls the async iterator's return() and tears down
    // the Claude process after the first result. Instead, result messages only
    // settle the current turn; the pump keeps waiting for the next queued user
    // message on the same SDK query.
    session.pump = (async () => {
      let terminalError = null;
      try {
        for await (const message of query) {
          if (message.session_id) session.sessionId = message.session_id;
          const turn = session.activeTurn;
          if (!turn) continue;
          if (message.type === "stream_event") {
            const text = textFromStreamEvent(message.event);
            if (text) {
              turn.streamed += text;
              turn.onData?.(encodeStreamJsonDelta(text));
            }
          } else if (message.type === "result") {
            if (message.subtype === "success") {
              const result = message.result == null ? turn.streamed : String(message.result);
              turn.onData?.(encodeStreamJsonResult(result));
              turn.finish({ status: 0, stdout: result, stderr: "", error: null });
            } else {
              const detail = Array.isArray(message.errors) ? message.errors.filter(Boolean).join("\n") : message.result;
              const error = new Error(detail || `claude-agent-sdk result error: ${message.subtype}`);
              turn.finish({ status: 1, stdout: turn.streamed, stderr: error.message, error });
            }
          }
        }
        terminalError = new Error("claude-agent-sdk connection closed");
      } catch (error) {
        terminalError = error;
      } finally {
        session.closed = true;
        session.terminalError = terminalError;
        clearTimeout(session.idleTimer);
        session.queue.close();
        if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
        if (session.activeTurn) {
          session.activeTurn.finish({
            status: null,
            stdout: session.activeTurn.streamed,
            stderr: String(terminalError?.message || terminalError || ""),
            error: terminalError,
          });
        }
      }
    })();
    return session;
  };

  const run = (opts) => withLock(opts.sessionKey || "default", async () => {
    const { sessionKey = "default", prompt, signal, onData, timeoutMs = 0 } = opts;
    if (signal?.aborted) return { status: null, stdout: "", stderr: "", aborted: true, error: new Error("cancelled") };
    let session;
    try {
      session = await ensureSession(sessionKey, opts);
    } catch (error) {
      return { status: null, stdout: "", stderr: "", error };
    }
    if (session.closed) {
      const error = session.terminalError || new Error("claude-agent-sdk connection closed");
      return { status: null, stdout: "", stderr: String(error.message || error), error };
    }

    clearTimeout(session.idleTimer);
    const result = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const turn = {
        streamed: "",
        onData,
        finish(value) {
          if (settled) return;
          settled = true;
          if (session.activeTurn === turn) session.activeTurn = null;
          if (signal) signal.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
          resolve(value);
        },
      };
      const onAbort = () => {
        const value = { status: null, stdout: turn.streamed, stderr: "", aborted: true, error: new Error("cancelled") };
        Promise.resolve(session.query.interrupt?.()).catch(() => {});
        closeSession(sessionKey, session, value);
      };
      session.activeTurn = turn;
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error(`timed out after ${timeoutMs}ms`);
          Promise.resolve(session.query.interrupt?.()).catch(() => {});
          closeSession(sessionKey, session, { status: null, stdout: turn.streamed, stderr: error.message, error });
        }, timeoutMs);
        timer.unref?.();
      }
      session.queue.push({
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        session_id: session.sessionId,
      });
    });

    if (sessions.get(sessionKey) === session) armIdleTimer(sessionKey);
    return result;
  });

  return { run, shutdown: () => { for (const key of [...sessions.keys()]) closeSession(key); } };
}

/** NDJSON-framed JSON-RPC client over a child process's stdio. */
function createJsonRpcClient(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  const messageHandlers = new Set();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || "codex app-server error"));
        else resolve(message.result);
      } else if (message.method) {
        for (const handler of messageHandlers) handler(message.method, message.params, message.id);
      }
    }
  });

  const rejectAllPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on("exit", () => rejectAllPending(new Error("codex app-server exited")));
  child.on("error", (error) => rejectAllPending(error));

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    respond(id, result) {
      child.stdin.write(`${JSON.stringify({ id, result })}\n`);
    },
    respondError(id, message) {
      child.stdin.write(`${JSON.stringify({ id, error: { code: -32601, message } })}\n`);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
  };
}

function mapCodexApproval(permissionMode) {
  if (permissionMode === "yolo") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  return {};
}

/**
 * @param {{ spawnFn?: Function, idleCloseMs?: number }} [opts]
 */
export function createCodexAppServerExecutor({ spawnFn = spawn, idleCloseMs = DEFAULT_IDLE_CLOSE_MS } = {}) {
  const sessions = new Map(); // sessionKey -> { child, rpc, threadId, idleTimer }
  const withLock = createKeyedMutex();

  const closeSession = (sessionKey) => {
    const session = sessions.get(sessionKey);
    if (!session) return;
    sessions.delete(sessionKey);
    clearTimeout(session.idleTimer);
    try { session.child.kill("SIGTERM"); } catch { /* already gone */ }
  };

  const armIdleTimer = (sessionKey) => {
    const session = sessions.get(sessionKey);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => closeSession(sessionKey), idleCloseMs);
    session.idleTimer.unref?.();
  };

  const ensureSession = async (sessionKey, opts) => {
    const existing = sessions.get(sessionKey);
    const fingerprint = connectionFingerprint(opts);
    if (existing && existing.fingerprint === fingerprint) return existing;
    if (existing) closeSession(sessionKey);

    const child = spawnFn("codex", ["app-server"], {
      cwd: opts.cwd,
      env: scrubbedChildEnv(opts.mcp?.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = createJsonRpcClient(child);
    await rpc.request("initialize", { clientInfo: { name: "agensis-agent", version: opts.clientVersion || "unknown" } });
    rpc.notify("initialized");

    const config = opts.leanCli && opts.mcp
      ? { mcp_servers: { agensis: { url: opts.mcp.url, bearer_token_env_var: "AGENSIS_MCP_TOKEN" } } }
      : undefined;
    const threadResult = await rpc.request("thread/start", {
      cwd: opts.cwd,
      ephemeral: opts.leanCli || undefined,
      model: opts.model,
      config,
      ...mapCodexApproval(opts.permissionMode),
    });

    const session = { child, rpc, threadId: threadResult.thread.id, fingerprint, idleTimer: null };
    sessions.set(sessionKey, session);
    return session;
  };

  const run = (opts) => withLock(opts.sessionKey || "default", async () => {
    const { sessionKey = "default", prompt, signal, onData, timeoutMs = 0 } = opts;
    if (signal?.aborted) return { status: null, stdout: "", stderr: "", aborted: true, error: new Error("cancelled") };
    let session;
    try {
      session = await ensureSession(sessionKey, opts);
    } catch (error) {
      return { status: null, stdout: "", stderr: "", error };
    }

    let streamed = "";
    let finalText = "";
    let turnId = null;
    let aborted = false;

    const result = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; cleanup(); resolve(value); } };

      const offMessage = session.rpc.onMessage((method, params, requestId) => {
        if (requestId !== undefined) {
          if (method === "item/commandExecution/requestApproval") {
            const decision = opts.permissionMode === "yolo" ? "acceptForSession" : "decline";
            session.rpc.respond(requestId, { decision });
          } else if (method === "item/fileChange/requestApproval") {
            const decision = opts.permissionMode === "yolo" || opts.permissionMode === "accept_edits"
              ? "acceptForSession"
              : "decline";
            session.rpc.respond(requestId, { decision });
          } else {
            session.rpc.respondError(requestId, `Agensis daemon cannot handle Codex request ${method}`);
          }
          return;
        }
        if (!params || params.threadId !== session.threadId) return;
        if (method === "turn/started") { turnId = params.turn?.id ?? turnId; return; }
        if (turnId && params.turnId && params.turnId !== turnId) return;
        if (method === "item/agentMessage/delta") {
          streamed += params.delta || "";
          onData?.(params.delta || "");
        } else if (method === "item/completed" && params.item?.type === "agentMessage") {
          finalText = params.item.text || finalText;
        } else if (method === "turn/completed") {
          const failed = params.turn?.status === "failed" || params.turn?.error;
          finish({
            status: failed ? 1 : 0,
            stdout: finalText || streamed,
            stderr: failed ? String(params.turn?.error?.message || params.turn?.error || "") : "",
            error: failed ? new Error(String(params.turn?.error?.message || params.turn?.error || "codex turn failed")) : null,
          });
        }
      });

      const onAbort = () => {
        aborted = true;
        session.rpc.request("turn/interrupt", { threadId: session.threadId }).catch(() => {});
        const value = { status: null, stdout: streamed, stderr: "", aborted: true, error: new Error("cancelled") };
        finish(value);
        closeSession(sessionKey);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      const timer = timeoutMs > 0 ? setTimeout(() => {
        const error = new Error(`timed out after ${timeoutMs}ms`);
        session.rpc.request("turn/interrupt", { threadId: session.threadId }).catch(() => {});
        finish({ status: null, stdout: streamed, stderr: error.message, error });
        closeSession(sessionKey);
      }, timeoutMs) : null;
      timer?.unref?.();

      function cleanup() {
        offMessage();
        if (signal) signal.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      }

      session.rpc.request("turn/start", { threadId: session.threadId, input: [{ type: "text", text: prompt }] })
        .then((started) => { turnId = started?.turn?.id || turnId; })
        .catch((error) => finish({ status: null, stdout: "", stderr: "", error }));
    });

    if (!aborted) armIdleTimer(sessionKey);
    return result;
  });

  return { run, shutdown: () => { for (const key of [...sessions.keys()]) closeSession(key); } };
}
