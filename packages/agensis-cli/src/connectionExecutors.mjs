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
import { isAllowedByStoredRules, jobPermissionRules } from "./permissions.mjs";
import { stopFromCodexTurn, stopFromSdkResult, stopValue } from "./stopReasons.mjs";

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;

// How long to keep reading a session AFTER interrupting it, hoping the runtime
// settles the abandoned turn on its own.
//
// A turn that stops early (cancel, idle deadline, hard deadline) used to take
// the whole session down with it, so the next job on that silo paid a cold
// start for someone else's cancellation. Interrupting and then WATCHING is the
// difference between "this turn is over" and "this connection is unusable" —
// two claims that were previously conflated.
//
// The drain runs in the BACKGROUND: the caller's result is resolved the instant
// the deadline fires, exactly as before, so cancelling still feels immediate.
// The drain only decides whether the session is kept or torn down. If the
// runtime never settles the turn we are back to today's behaviour — close it —
// which makes this a bounded bet: best case we keep a warm session, worst case
// we spent 5s of a background timer finding out we could not.
const CANCEL_DRAIN_MS = 5 * 1000;

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

// The workspace's OWN MCP tools are never permission-gated.
//
// An agent connected to a workspace IS a member of it — asking a human to
// approve @scout calling create_task in the workspace it already belongs to is
// a prompt nobody can answer, because the daemon runs headless on someone
// else's machine. Without this the tools resolve, the call reaches the
// permission layer, and it is denied with "you haven't granted it yet".
//
// This CANNOT be solved with a settings file: lean mode (the default, see
// agensis.mjs `leanCli`) passes `settingSources: []` below, so the SDK reads no
// settings.local.json at all — grants written there are silently ignored, and
// restarting changes nothing. It also cannot be solved by permissionMode alone:
// 'acceptEdits' only covers file edits, leaving bypassPermissions ('yolo') as
// the only working option, which hands over unrestricted shell to get a task
// created. Allow-listing the server prefix grants exactly the workspace tools
// and nothing else.
const AGENSIS_MCP_ALLOWED_TOOLS = ["mcp__agensis"];

// The SDK runs a NATIVE claude binary, and native builds ship WITHOUT the
// dedicated Grep/Glob tools unless they are named here — sdk.d.ts says so on the
// `tools` option ("native builds may provide search via Bash find/grep instead
// of the dedicated Grep/Glob tools. List Grep/Glob here or in `allowedTools` to
// get them"), and the installed 0.3.218 binary confirms it: the session's tool
// list is 29 entries without these two and 31 with them. Absent, every search
// the agent runs is a Bash `grep`/`find` whose entire stdout lands in context
// unbounded, so one question becomes dozens of shell round trips. Both tools are
// read-only and strictly weaker than the Bash the agent already has, so naming
// them costs nothing and is not a permission widening in practice.
const SEARCH_ALLOWED_TOOLS = ["Grep", "Glob"];

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
// Tool activity has no text, so a tool-only turn (read/grep/bash/subagent —
// most of what the agent actually does) produced ZERO deltas and left the chat
// sitting on "Thinking …" in silence. Steps ride the same onData channel as
// their own NDJSON line; createStreamJsonParser (agensis.mjs) routes them to
// onStep instead of into the reply text.
function encodeAgensisStep(step) {
  return `${JSON.stringify({ type: "agensis_step", step })}\n`;
}
// A finished assistant TEXT block. Without it every text the model wrote in a
// turn was concatenated into one ever-growing placeholder message, so five
// separate thoughts ran together in one bubble and the human had no boundary to
// read or interrupt at. A segment closes the current message with its own
// complete text; the server then opens the next placeholder, so the transcript
// becomes text, tool chips, text — the order the model actually produced.
function encodeAgensisSegment(segment) {
  return `${JSON.stringify({ type: "agensis_segment", segment })}\n`;
}

const TOOL_DETAIL_KEYS = ["file_path", "path", "pattern", "command", "description", "prompt"];
const TOOL_DETAIL_MAX = 120;
// Narration and results get more room than a tool's argument line: they are the
// only prose in the strip, and 120 chars cuts most sentences in half.
const PROSE_DETAIL_MAX = 240;

function condense(value, max) {
  const line = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * The model's reasoning between tool calls.
 *
 * A reasoning model on a long tool sweep narrates in `thinking` blocks, not
 * `text` blocks — so the assistant handler's `type === "text"` filter dropped
 * ALL of it and the thread showed a wall of tool chips with nothing said in
 * between. The daemon had no concept of a thinking block at all.
 */
export function summarizeThinking(text) {
  return condense(text, PROSE_DETAIL_MAX);
}

/**
 * What a tool actually returned.
 *
 * The pump had no `user` branch, and `user` is exactly the SDK message type
 * carrying `tool_result` back — so every chip said what was called and never
 * whether it worked. Half of each round trip was invisible by construction.
 */
export function summarizeToolResult(block) {
  const raw = block?.content;
  const text = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? raw.filter((part) => part && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text).join(" ")
      : "";
  const line = condense(text, PROSE_DETAIL_MAX);
  if (block?.is_error) return line ? `Failed: ${line}` : "Failed";
  return line;
}

/** Short single-line summary of a tool_use input — never the whole input object. */
export function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of TOOL_DETAIL_KEYS) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const line = value.replace(/\s+/g, " ").trim();
    if (!line) continue;
    return line.length > TOOL_DETAIL_MAX ? `${line.slice(0, TOOL_DETAIL_MAX)}…` : line;
  }
  return "";
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
    // Whether the session was built with an approval callback at all — not the
    // callback itself, which is stable for the process. `canUseTool` is fixed at
    // session creation, so a session opened by a job that had no broker would be
    // REUSED by one that does, and the SDK would throw "canUseTool callback is
    // not provided." on the first tool needing approval. A changed answer here
    // rebuilds the session instead.
    canAsk: !!opts.requestPermission,
  });
}

/**
 * Ask a human, through Agensis, whether this tool call may run.
 *
 * Bound to the SESSION, but every answer it needs — which job to post into,
 * which rules the workspace already granted — belongs to the TURN, because a
 * pooled session outlives any single job. `session.activeTurn` is the turn the
 * CLI is executing right now, so it is the correct source; a request arriving
 * with no active turn cannot be routed to a conversation and is denied rather
 * than parked forever.
 *
 * A stored rule short-circuits the round trip entirely: the human already
 * answered this question permanently, and re-asking would make "always allow"
 * mean "ask me every time a new job starts".
 */
function makeCanUseTool(session, fallbackRequester) {
  return async (toolName, input, context = {}) => {
    const turn = session.activeTurn;
    if (!turn) {
      return { behavior: "deny", message: "This tool call arrived with no active job to ask about." };
    }
    // The turn's requester, not the session's: a pooled session is created once
    // and then serves jobs for the rest of the process, so binding the daemon's
    // socket-backed broker at creation time would pin whichever one happened to
    // be live for the first job.
    const requestPermission = turn.requestPermission || fallbackRequester;
    if (!requestPermission) {
      return { behavior: "deny", message: "This agent has no way to ask for approval right now." };
    }
    if (isAllowedByStoredRules(turn.permissionRules, { toolName, input, suggestions: context.suggestions })) {
      return { behavior: "allow" };
    }
    const decision = await requestPermission({
      jobId: turn.jobId,
      toolName,
      title: context.title,
      description: context.description,
      detail: summarizeToolInput(input),
      input,
      suggestions: context.suggestions,
      signal: context.signal,
    });
    if (decision?.behavior !== "allow") {
      return { behavior: "deny", message: decision?.message || "This tool call was not approved." };
    }
    // 'once' grants exactly this call. Both wider scopes hand the SDK its own
    // suggestions back, which is what stops it re-prompting for the rest of the
    // session; 'always' is additionally persisted server-side onto the agent, so
    // it survives into jobs this session will never see.
    const updatedPermissions = decision.scope === "once" ? undefined : context.suggestions;
    return updatedPermissions?.length ? { behavior: "allow", updatedPermissions } : { behavior: "allow" };
  };
}

/**
 * @param {{ queryFn?: Function, idleCloseMs?: number, requestPermission?: Function, cancelDrainMs?: number }} [opts]
 */
export function createClaudeSdkExecutor({ queryFn, idleCloseMs = DEFAULT_IDLE_CLOSE_MS, requestPermission, cancelDrainMs = CANCEL_DRAIN_MS } = {}) {
  const sessions = new Map(); // sessionKey -> one long-lived SDK query + input queue
  const withLock = createKeyedMutex();

  const closeSession = (sessionKey, expectedSession, activeResult) => {
    const session = sessions.get(sessionKey);
    if (!session || (expectedSession && session !== expectedSession)) return;
    sessions.delete(sessionKey);
    clearTimeout(session.idleTimer);
    // Stop any drain watching this session: the question it was asking — is
    // this connection reusable — has just been answered "no".
    session.settleDrain?.();
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

  /**
   * Interrupt the runtime, then give it CANCEL_DRAIN_MS to settle the turn it
   * was just told to abandon. The caller has ALREADY been answered — this only
   * decides whether the session survives for the next job or is torn down.
   *
   * Previously every early exit went straight to closeSession, so one person
   * cancelling cost the next job on that silo a cold start, and we never found
   * out whether interrupt() was enough on its own. Now we ask.
   */
  const drainAfterInterrupt = (sessionKey, session) => {
    if (session.closed || sessions.get(sessionKey) !== session) return;
    Promise.resolve(session.query.interrupt?.()).catch(() => { /* the drain timer is the real backstop */ });
    if (session.settleDrain) return; // one watcher per session is enough
    const timer = setTimeout(() => {
      // The runtime never acknowledged the interrupt, so we cannot tell a
      // finished turn from one still streaming into a transcript nobody is
      // reading. Tear it down — today's behaviour, now reached on evidence
      // rather than by default.
      session.settleDrain = null;
      closeSession(sessionKey, session);
    }, cancelDrainMs);
    timer.unref?.();
    session.settleDrain = () => {
      session.settleDrain = null;
      clearTimeout(timer);
      // Settled: the runtime is idle and this session is reusable. Put it back
      // on the normal idle-close schedule rather than leaving it unattended.
      if (sessions.get(sessionKey) === session) armIdleTimer(sessionKey);
    };
  };

  const ensureSession = async (sessionKey, opts) => {
    const existing = sessions.get(sessionKey);
    const fingerprint = connectionFingerprint(opts);
    // A session still mid-drain has an interrupted turn that has NOT been seen
    // to end. Handing it to the next job would let the abandoned turn's output
    // land in a conversation it has nothing to do with — the session is only
    // reusable once the drain has settled and proved the runtime went idle.
    // Closing it here is exactly the behaviour that existed before the drain,
    // so the worst case is unchanged rather than newly wrong.
    if (existing && existing.settleDrain) closeSession(sessionKey, existing);
    else if (existing && existing.fingerprint === fingerprint && !existing.closed) return existing;
    else if (existing) closeSession(sessionKey, existing);
    if (!queryFn) {
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      queryFn = mod.query;
    }
    const queue = new PushQueue();
    const permission = mapClaudePermission(opts.permissionMode);
    // 'bypassPermissions' ('yolo') auto-approves every call BEFORE the callback
    // is consulted, so a canUseTool handed over alongside it is dead code: the
    // SDK never invokes it and warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED on every
    // session it builds. yolo IS the human saying "don't ask me", so drop the
    // broker instead of attaching one that only pretends to gate.
    const canAsk = permission.permissionMode !== "bypassPermissions"
      && !!(requestPermission || opts.requestPermission);
    // Allocated BEFORE the query so canUseTool can close over the same object the
    // run loop later writes `activeTurn` onto. Rebuilding the object afterwards
    // would hand the callback a stale copy whose activeTurn is forever null.
    const session = {
      query: null,
      queue,
      sessionId: "",
      idleTimer: null,
      activeTurn: null,
      closed: false,
      terminalError: null,
      fingerprint,
      // Set while a bounded post-interrupt drain is watching this session; the
      // pump calls it when the abandoned turn's terminal result finally lands.
      settleDrain: null,
    };
    const mcpServers = opts.leanCli && opts.mcp
      ? { agensis: { type: "http", url: opts.mcp.url, headers: { Authorization: "Bearer ${AGENSIS_MCP_TOKEN}" } } }
      : undefined;
    const query = queryFn({
      prompt: queue,
      options: {
        cwd: opts.cwd,
        model: opts.model,
        ...permission,
        // Always allowed, in every permission mode — see AGENSIS_MCP_ALLOWED_TOOLS
        // and SEARCH_ALLOWED_TOOLS.
        allowedTools: [...AGENSIS_MCP_ALLOWED_TOOLS, ...SEARCH_ALLOWED_TOOLS],
        // Absent this the SDK throws "canUseTool callback is not provided." on the
        // first tool that needs approval, which surfaces as an opaque tool error
        // and leaves the model narrating an approval prompt that exists nowhere.
        canUseTool: canAsk ? makeCanUseTool(session, requestPermission) : undefined,
        additionalDirectories: opts.hostFolders && opts.hostFolders.length ? opts.hostFolders : undefined,
        mcpServers,
        strictMcpConfig: opts.leanCli ? true : undefined,
        settingSources: opts.leanCli ? [] : undefined,
        persistSession: opts.leanCli ? false : undefined,
        includePartialMessages: true,
        // Adaptive is already the default on models that support it, so this is
        // making the intent explicit rather than switching something on: the
        // narration the step strip surfaces lives in `thinking` blocks, and a
        // future model default of 'disabled' would silently empty the strip
        // again with nothing in this file to explain why.
        thinking: { type: "adaptive" },
        env: scrubbedChildEnv(opts.mcp?.env),
      },
    });
    session.query = query;
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
          if (!turn) {
            // An interrupted turn was already resolved for its caller, but the
            // SDK still owes this session one terminal `result` for it. Seeing
            // that result is the proof the CLI went idle rather than wedged,
            // and therefore the proof this session is safe to hand to the next
            // job. Nothing is emitted from here: the turn's transcript is
            // closed and re-opening it would append output to a job the human
            // has already been told is over.
            if (message.type === "result") session.settleDrain?.();
            continue;
          }
          // ANY message addressed to the live turn is the agent doing something.
          // Deliberately broader than "text arrived": a turn can spend minutes
          // inside one tool call without emitting a token, and killing those was
          // the original complaint that set the server's window to 10 minutes.
          turn.touch();
          if (message.type === "stream_event") {
            const text = textFromStreamEvent(message.event);
            if (text) {
              turn.streamed += text;
              turn.onData?.(encodeStreamJsonDelta(text));
            }
          } else if (message.type === "result") {
            // Everything the SDK knows about how this turn ended. Previously
            // only `subtype` was read here and the rest was dropped on the
            // floor, so a turn that hit its token budget and a turn whose tool
            // was denied arrived downstream as the same opaque string.
            const stop = stopFromSdkResult(message);
            if (message.subtype === "success") {
              const result = message.result == null ? turn.text : String(message.result);
              turn.onData?.(encodeStreamJsonResult(result));
              turn.finish({ status: 0, stdout: result, stderr: "", error: null, stop });
            } else {
              const detail = Array.isArray(message.errors) ? message.errors.filter(Boolean).join("\n") : message.result;
              const error = new Error(detail || `claude-agent-sdk result error: ${message.subtype}`);
              turn.finish({ status: 1, stdout: turn.text, stderr: error.message, error, stop });
            }
          } else if (message.type === "assistant") {
            // An assistant message is a COMPLETED block of the turn: its text
            // (already streamed above as deltas) is done, and the tool_use blocks
            // beside it are what that text just announced. The segment is emitted
            // FIRST so the transcript keeps the model's own order — text, then
            // the tools it called — and the text is never re-emitted as deltas,
            // which would double every answer.
            const content = message.message?.content;
            if (Array.isArray(content)) {
              const text = content
                .filter((block) => block && block.type === "text" && typeof block.text === "string")
                .map((block) => block.text)
                .join("");
              if (text) {
                turn.onData?.(encodeAgensisSegment({ text }));
                // Block closed: bank what it streamed and restart the buffer so
                // the next block begins empty instead of replaying this one.
                turn.flushed += turn.streamed;
                turn.streamed = "";
              }
              // ONE ordered pass, so narration keeps its place relative to the
              // calls it introduces: think, call, think, call — the order the
              // model actually produced. Two separate loops would batch all the
              // thinking ahead of all the tools and lose that.
              for (const block of content) {
                if (!block) continue;
                if (block.type === "thinking") {
                  const detail = summarizeThinking(block.thinking ?? block.text);
                  if (detail) turn.onData?.(encodeAgensisStep({ kind: "thinking", name: "Thinking", detail }));
                } else if (block.type === "tool_use" && block.name) {
                  // Remember the name so the tool_result arriving later on a
                  // `user` message can be labelled with the tool it belongs to
                  // instead of a bare id.
                  if (block.id) turn.toolNames.set(String(block.id), String(block.name));
                  turn.onData?.(encodeAgensisStep({
                    kind: "tool",
                    name: String(block.name),
                    detail: summarizeToolInput(block.input),
                  }));
                }
              }
            }
          } else if (message.type === "user") {
            // Tool results come back as a `user` message. Without this branch the
            // strip showed every call and no outcome.
            const content = message.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!block || block.type !== "tool_result") continue;
                // ONLY failures get a chip.
                //
                // 0.1.41 chipped every result, which doubled the strip: the server
                // hardcodes message_kind='tool_step' and persists only name/detail,
                // dropping step.kind — so a result is indistinguishable from a call
                // in the DB and in the UI. Nine successful calls rendered as
                // eighteen identical chips and read as "17 tool calls and not a word
                // said". Restoring per-result chips needs a kind the server actually
                // stores; until then a success is silent and only a FAILURE — the
                // half a reader cannot infer from the call itself — earns a row.
                if (!block.is_error) continue;
                const detail = summarizeToolResult(block);
                if (!detail) continue;
                turn.onData?.(encodeAgensisStep({
                  kind: "tool_result",
                  name: turn.toolNames.get(String(block.tool_use_id)) || "Result",
                  detail,
                }));
              }
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
        // A session that dies mid-drain will never settle the abandoned turn.
        // Release the waiter so its timer does not outlive the session it was
        // asking about.
        session.settleDrain?.();
        if (session.activeTurn) {
          session.activeTurn.finish({
            status: null,
            stdout: session.activeTurn.text,
            stderr: String(terminalError?.message || terminalError || ""),
            error: terminalError,
            // The connection went away underneath a live turn. That is a
            // materially different answer to "why did it stop" than anything
            // the agent itself could report, and the one the human most needs:
            // nothing is wrong with their request, the pipe broke.
            stop: stopValue("connection_lost"),
          });
        }
      }
    })();
    return session;
  };

  const run = (opts) => withLock(opts.sessionKey || "default", async () => {
    const { sessionKey = "default", prompt, signal, onData, timeoutMs = 0, idleTimeoutMs = 0 } = opts;
    if (signal?.aborted) return { status: null, stdout: "", stderr: "", aborted: true, error: new Error("cancelled"), stop: stopValue("cancelled") };
    let session;
    try {
      session = await ensureSession(sessionKey, opts);
    } catch (error) {
      return { status: null, stdout: "", stderr: "", error, stop: stopValue("connection_lost") };
    }
    if (session.closed) {
      const error = session.terminalError || new Error("claude-agent-sdk connection closed");
      return { status: null, stdout: "", stderr: String(error.message || error), error, stop: stopValue("connection_lost") };
    }

    clearTimeout(session.idleTimer);
    const result = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let idleTimer = null;
      // Restart the idle deadline. Hoisted deliberately so `turn.touch` below
      // can name it: the turn object has to exist before the pump can rearm it,
      // and the pump is the only thing that knows the agent is still alive.
      function armIdle() {
        if (!(idleTimeoutMs > 0) || settled) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          // SILENCE, not slowness: the hard deadline below is what caps a turn
          // that is working the whole time. Reported as its own reason because
          // "produced nothing for nine minutes" and "ran for thirty minutes"
          // need different answers from the human reading it.
          const error = new Error(`no output for ${idleTimeoutMs}ms`);
          turn.finish({ status: null, stdout: turn.text, stderr: error.message, error, stop: stopValue("idle_timeout") });
          drainAfterInterrupt(sessionKey, session);
        }, idleTimeoutMs);
        idleTimer.unref?.();
      }
      const turn = {
        touch: armIdle,
        streamed: "", // tokens of the block being written; reset at each segment
        flushed: "", // tokens of the blocks already closed by a segment
        // Every fallback wants the whole turn, not just the open block.
        get text() { return this.flushed + this.streamed; },
        onData,
        // Permission context: which conversation a request posts into, and what
        // the workspace has already granted this agent permanently. Held on the
        // TURN, not the session, because a pooled session serves many jobs and
        // the rules ride in on each job's payload.
        jobId: opts.job?.id || "",
        // tool_use id -> tool name, so a tool_result can be labelled with what it
        // came from. Per TURN, not per session: a pooled session runs many jobs
        // and this would otherwise grow for the life of the process.
        toolNames: new Map(),
        permissionRules: jobPermissionRules(opts.job),
        requestPermission: opts.requestPermission || null,
        finish(value) {
          if (settled) return;
          settled = true;
          if (session.activeTurn === turn) session.activeTurn = null;
          if (signal) signal.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
          if (idleTimer) clearTimeout(idleTimer);
          resolve(value);
        },
      };
      const onAbort = () => {
        // Answer the caller NOW — a human who pressed cancel should not wait on
        // the runtime acknowledging it — and let the drain decide the session's
        // fate in the background.
        turn.finish({ status: null, stdout: turn.text, stderr: "", aborted: true, error: new Error("cancelled"), stop: stopValue("cancelled") });
        drainAfterInterrupt(sessionKey, session);
      };
      session.activeTurn = turn;
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) {
        // The HARD ceiling: an absolute cap on the turn no amount of activity
        // can extend. Distinct from the idle deadline above, which asks a
        // different question — the two used to be one flat timer, so a wedged
        // turn and a genuinely long one were indistinguishable.
        timer = setTimeout(() => {
          const error = new Error(`timed out after ${timeoutMs}ms`);
          turn.finish({ status: null, stdout: turn.text, stderr: error.message, error, stop: stopValue("hard_timeout") });
          drainAfterInterrupt(sessionKey, session);
        }, timeoutMs);
        timer.unref?.();
      }
      armIdle();
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

/**
 * NDJSON-framed JSON-RPC client over a child process's stdio.
 *
 * @param child   the spawned process
 * @param options.requestTimeoutMs  ceiling on a single request. A JSON-RPC
 *   request that is never answered used to hang FOREVER: the promise is settled
 *   only from the stdout reader or the exit/error handlers, so a child that is
 *   alive but wedged (or one that simply never implements the method) settles
 *   nothing. Because these calls are made under `withLock(sessionKey)`, one such
 *   request permanently wedges every future job on that session key too — the
 *   lock is never released. A deadline turns "this agent never answers again"
 *   into "this turn failed".
 */
function createJsonRpcClient(child, { requestTimeoutMs = 120_000 } = {}) {
  let nextId = 1;
  let buffer = "";
  let exited = false;
  const pending = new Map();
  const messageHandlers = new Set();
  // Bounded tail of the child's stderr, kept for diagnostics.
  //
  // stdio[2] is 'pipe' and NOTHING read it. A pipe nobody drains fills its OS
  // buffer (~64KB) and then BLOCKS the writer — so a chatty `codex app-server`
  // does not merely lose its logs, it deadlocks itself mid-write and stops
  // answering JSON-RPC entirely, which presents as an agent that has silently
  // stopped. Draining is the fix; keeping a capped tail is the part that makes
  // the eventual failure diagnosable.
  let stderrTail = "";
  const STDERR_TAIL_LIMIT = 8 * 1024;
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    // Never let the drain itself become the unhandled 'error' that kills us.
    child.stderr.on("error", () => { });
  }

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
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.on("exit", () => {
    exited = true;
    const detail = stderrTail.trim().slice(-500);
    rejectAllPending(new Error(`codex app-server exited${detail ? `: ${detail}` : ""}`));
  });
  child.on("error", (error) => { exited = true; rejectAllPending(error); });

  return {
    // Only a POSITIVE indication of death counts. `exited` (set by the 'exit'
    // and 'error' handlers below) is the authoritative signal; the property
    // checks are a secondary guard for a child that died before those attached.
    // Both use loose null so that `undefined` — "this object does not report
    // exitCode", which is true of any stub and of a process that has not been
    // spawned yet — reads as alive rather than dead. Treating absence of
    // information as death would recycle a perfectly good pooled session on
    // every single job, which is the opposite of what this pool is for.
    isAlive: () => !exited && child.exitCode == null && child.killed !== true,
    stderrTail: () => stderrTail,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // A write to a dead child's stdin throws EPIPE rather than settling the
        // promise, so the caller would wait on a request that was never sent.
        if (exited) {
          reject(new Error("codex app-server is not running"));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server did not answer ${method} within ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
        timer.unref?.();
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
          timer,
        });
        try {
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    // These three are fire-and-forget, so an EPIPE against a child that has
    // already exited is noise, not news — but an UNCAUGHT one still unwinds
    // whatever called it (an approval reply, mid-turn). Swallow deliberately:
    // the request path above is where a dead child is reported.
    notify(method, params) {
      try { child.stdin.write(`${JSON.stringify({ method, params })}\n`); } catch { /* child gone */ }
    },
    respond(id, result) {
      try { child.stdin.write(`${JSON.stringify({ id, result })}\n`); } catch { /* child gone */ }
    },
    respondError(id, message) {
      try { child.stdin.write(`${JSON.stringify({ id, error: { code: -32601, message } })}\n`); } catch { /* child gone */ }
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
 * Pick a decision string Codex will actually accept.
 *
 * `CommandExecutionRequestApprovalParams.availableDecisions` is "the ordered
 * list of decisions the client may present for this prompt" — reading it beats
 * hard-coding an enum that moves between codex-cli releases. `preferences` is
 * ordered best-first; `fallback` is used when the server sent no list at all,
 * and is deliberately a value this codebase has already exchanged with a live
 * app-server rather than the one we'd rather have.
 *
 * Consequence worth knowing: against an app-server too old to advertise its
 * decisions, an "allow once" is delivered as `acceptForSession`, because there
 * is no narrower value we can be sure it understands and the human did say yes.
 * codex-cli 0.145.0 — the version this executor was verified against — sends
 * the list, so this only bites older servers.
 */
function pickCodexDecision(availableDecisions, preferences, fallback) {
  const available = Array.isArray(availableDecisions) ? availableDecisions.map(String) : [];
  if (available.length) {
    const match = preferences.find((candidate) => available.includes(candidate));
    if (match) return match;
  }
  return fallback;
}

const CODEX_DECLINE = { preferences: ["decline"], fallback: "decline" };
const CODEX_ALLOW_ONCE = { preferences: ["accept", "acceptForSession"], fallback: "acceptForSession" };
const CODEX_ALLOW_SESSION = { preferences: ["acceptForSession", "accept"], fallback: "acceptForSession" };

function codexDecision(availableDecisions, choice) {
  return pickCodexDecision(availableDecisions, choice.preferences, choice.fallback);
}

/** One line describing what Codex is asking to do, for the human reading the prompt. */
function summarizeCodexApproval(method, params) {
  const command = params?.command;
  const line = Array.isArray(command) ? command.join(" ") : String(command || "");
  if (line.trim()) return line.replace(/\s+/g, " ").trim().slice(0, 200);
  const changes = params?.fileChanges || params?.changes;
  const paths = changes && typeof changes === "object" ? Object.keys(changes) : [];
  if (paths.length) return paths.slice(0, 4).join(", ");
  return method === "item/fileChange/requestApproval" ? "apply a file change" : "run a command";
}

/**
 * @param {{ spawnFn?: Function, idleCloseMs?: number, requestPermission?: Function }} [opts]
 */
export function createCodexAppServerExecutor({ spawnFn = spawn, idleCloseMs = DEFAULT_IDLE_CLOSE_MS, requestPermission } = {}) {
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
    // A matching fingerprint used to be the ONLY condition for reuse, so a
    // pooled session whose `codex app-server` had died — crashed, OOM-killed,
    // killed by the user — was handed straight back. Every request against it
    // then rejects with "codex app-server exited", and because the dead session
    // stays in the map, the NEXT turn is handed the same corpse: the agent is
    // wedged until something else happens to evict the key. Liveness is cheap to
    // check and is the difference between one failed turn and a dead agent.
    if (existing && existing.fingerprint === fingerprint && existing.rpc.isAlive()) return existing;
    if (existing) closeSession(sessionKey);

    const child = spawnFn("codex", ["app-server"], {
      cwd: opts.cwd,
      env: scrubbedChildEnv(opts.mcp?.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = createJsonRpcClient(child);
    // The handshake is the only stretch where a spawned child is owned by
    // NOTHING: it is not in `sessions` yet, so neither closeSession nor shutdown
    // can reach it. If either request rejects — and now that requests have a
    // deadline, "the app-server came up wedged" rejects rather than hanging —
    // an un-killed `codex app-server` is left behind on every attempt, one per
    // retry, until the machine runs out of processes.
    try {
      await rpc.request("initialize", { clientInfo: { name: "agensis-agent", version: opts.clientVersion || "unknown" } });
      rpc.notify("initialized");

      const config = opts.leanCli && opts.mcp
        ? { mcp_servers: { agensis: { url: opts.mcp.url, bearer_token_env_var: "AGENSIS_MCP_TOKEN" } } }
        : undefined;
      const threadResult = await rpc.request("thread/start", {
        cwd: opts.cwd,
        ephemeral: opts.leanCli || undefined,
        // An empty model means Auto. Omit it so Codex can use its current
        // configuration; the app-server rejects an explicit empty string.
        ...(opts.model ? { model: opts.model } : {}),
        config,
        ...mapCodexApproval(opts.permissionMode),
      });

      const session = { child, rpc, threadId: threadResult.thread.id, fingerprint, idleTimer: null };
      sessions.set(sessionKey, session);
      return session;
    } catch (error) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      throw error;
    }
  };

  const run = (opts) => withLock(opts.sessionKey || "default", async () => {
    const { sessionKey = "default", prompt, signal, onData, timeoutMs = 0, idleTimeoutMs = 0 } = opts;
    if (signal?.aborted) return { status: null, stdout: "", stderr: "", aborted: true, error: new Error("cancelled"), stop: stopValue("cancelled") };
    let session;
    try {
      session = await ensureSession(sessionKey, opts);
    } catch (error) {
      return { status: null, stdout: "", stderr: "", error, stop: stopValue("connection_lost") };
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
          const isCommand = method === "item/commandExecution/requestApproval";
          const isFileChange = method === "item/fileChange/requestApproval";
          if (!isCommand && !isFileChange) {
            session.rpc.respondError(requestId, `Agensis daemon cannot handle Codex request ${method}`);
            return;
          }
          // The permission mode can still answer without a human: yolo clears
          // everything, and accept_edits is exactly a standing yes to file
          // changes. Only what neither covers is worth interrupting someone for.
          const preCleared = opts.permissionMode === "yolo" || (isFileChange && opts.permissionMode === "accept_edits");
          const ask = opts.requestPermission || requestPermission;
          if (preCleared || !ask) {
            // Without a broker this stays the old hard decline rather than a
            // silent grant — an agent that cannot ask must not self-approve.
            const decision = codexDecision(params?.availableDecisions, preCleared ? CODEX_ALLOW_SESSION : CODEX_DECLINE);
            session.rpc.respond(requestId, { decision });
            return;
          }
          // Codex offers no per-rule "always allow" the way the Claude SDK's
          // `suggestions` do, so no rule is passed and the broker offers only
          // once/session. Inventing a permanent rule here would mean storing
          // "this agent may run any command" behind an innocuous click.
          void Promise.resolve(ask({
            jobId: opts.job?.id || "",
            toolName: isCommand ? "Codex command" : "Codex file change",
            detail: summarizeCodexApproval(method, params),
            description: String(params?.reason || "").trim(),
            input: params || null,
          })).then((outcome) => {
            const choice = outcome?.behavior !== "allow" ? CODEX_DECLINE
              : outcome.scope === "once" ? CODEX_ALLOW_ONCE
                : CODEX_ALLOW_SESSION;
            session.rpc.respond(requestId, { decision: codexDecision(params?.availableDecisions, choice) });
          }).catch(() => {
            session.rpc.respond(requestId, { decision: codexDecision(params?.availableDecisions, CODEX_DECLINE) });
          });
          return;
        }
        if (!params || params.threadId !== session.threadId) return;
        if (method === "turn/started") { turnId = params.turn?.id ?? turnId; armIdle(); return; }
        if (turnId && params.turnId && params.turnId !== turnId) return;
        // Anything the thread says is the agent still working — same rule as the
        // Claude pump, so a tool-only stretch counts as activity, not silence.
        armIdle();
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
            stop: stopFromCodexTurn(params),
          });
        }
      });

      const onAbort = () => {
        aborted = true;
        session.rpc.request("turn/interrupt", { threadId: session.threadId }).catch(() => {});
        const value = { status: null, stdout: streamed, stderr: "", aborted: true, error: new Error("cancelled"), stop: stopValue("cancelled") };
        finish(value);
        closeSession(sessionKey);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      const timer = timeoutMs > 0 ? setTimeout(() => {
        const error = new Error(`timed out after ${timeoutMs}ms`);
        session.rpc.request("turn/interrupt", { threadId: session.threadId }).catch(() => {});
        finish({ status: null, stdout: streamed, stderr: error.message, error, stop: stopValue("hard_timeout") });
        closeSession(sessionKey);
      }, timeoutMs) : null;
      timer?.unref?.();

      // Codex keeps its session in a child process rather than an SDK pump, so
      // there is nothing to drain: an app-server that has gone quiet is killed
      // and respawned on the next job. The idle deadline exists here for the
      // reason it exists on the Claude side — so a silent wedge is REPORTED as
      // silence instead of waiting out the 30-minute ceiling.
      let idleTimer = null;
      function armIdle() {
        if (!(idleTimeoutMs > 0) || settled) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const error = new Error(`no output for ${idleTimeoutMs}ms`);
          session.rpc.request("turn/interrupt", { threadId: session.threadId }).catch(() => {});
          finish({ status: null, stdout: streamed, stderr: error.message, error, stop: stopValue("idle_timeout") });
          closeSession(sessionKey);
        }, idleTimeoutMs);
        idleTimer.unref?.();
      }

      function cleanup() {
        offMessage();
        if (signal) signal.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
      }

      armIdle();
      session.rpc.request("turn/start", { threadId: session.threadId, input: [{ type: "text", text: prompt }] })
        .then((started) => { turnId = started?.turn?.id || turnId; })
        .catch((error) => finish({ status: null, stdout: "", stderr: "", error }));
    });

    if (!aborted) armIdleTimer(sessionKey);
    return result;
  });

  return { run, shutdown: () => { for (const key of [...sessions.keys()]) closeSession(key); } };
}
