#!/usr/bin/env node
/**
 * inbetween-codex — single-terminal wrapper around the Codex CLI that
 * delivers InBetween messages directly into the live conversation via the
 * codex app-server JSON-RPC protocol.
 *
 * Architecture (v0.1.0+, layered-auth flow):
 *   1. Spawn `codex app-server --listen ws://127.0.0.1:0` in the background
 *      (stdio piped — we read its port from stderr).
 *   2. Open WS to the app-server, listen for `thread/started` from the TUI,
 *      capture its threadId.
 *   3. Spawn `codex --remote ws://127.0.0.1:PORT --dangerously-bypass-approvals-and-sandbox`
 *      with stdio: 'inherit' — Codex TUI takes over the *current* terminal.
 *   4. Watch ~/.inbetween/sessions/<cwdHash>.json for the agent token written
 *      by the InBetween MCP server when the user pastes a chat onboarding
 *      prompt (which calls agent_login(token) inside Codex). The MCP writes
 *      this file on every agent_login so we can pick it up.
 *   5. Once the token is known, open WS to the InBetween backend
 *      (Authorization: Bearer <auth_token>). Re-auth on agent change.
 *   6. When backend sends `new_message` → `turn/start` in Codex (or
 *      `turn/steer` if a turn is already active). Dedup by message_id.
 *   7. When the Codex TUI exits, the wrapper exits.
 *
 * No config file is required at startup. Identity arrives at runtime.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  watch,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// CONFIG — backend URLs only. No auth at startup.
// ---------------------------------------------------------------------------
const DEFAULT_BACKEND_WS_URL = "wss://inbetween.up.railway.app/ws";
const BACKEND_WS_URL = process.env.INBETWEEN_WS_URL || DEFAULT_BACKEND_WS_URL;

const SESSION_DIR = join(homedir(), ".inbetween", "sessions");
const cwdHash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
const SESSION_FILE = join(SESSION_DIR, `${cwdHash}.json`);

function readSession() {
  try {
    if (!existsSync(SESSION_FILE)) return null;
    const raw = readFileSync(SESSION_FILE, "utf-8").trim();
    if (!raw || raw === "{}") return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LOGGING — to a file, not stderr. Codex TUI uses an alt-screen buffer; any
// console.* call after launch corrupts the rendering. Banner is the only
// thing we print to stderr (briefly, before TUI starts).
// ---------------------------------------------------------------------------
const LOG_DIR = join(process.cwd(), ".inbetween");
const LOG_FILE = join(LOG_DIR, "codex-shell.log");
let logReady = false;
function ensureLogReady() {
  if (logReady) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      LOG_FILE,
      `\n\n=== inbetween-codex started at ${new Date().toISOString()} (cwd=${process.cwd()}) ===\n`,
    );
    logReady = true;
  } catch {
    // best-effort; if we can't write logs, just silently drop them
  }
}
function log(...parts) {
  ensureLogReady();
  if (!logReady) return;
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

// ANSI helpers (zero deps).
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

function printBanner(initialAgent) {
  const lines = [
    "",
    `  ${C.bold}${C.cyan}╭─────────────────────────────────────────────╮${C.reset}`,
    `  ${C.bold}${C.cyan}│${C.reset}  ${C.bold}InBetween${C.reset} ${C.dim}x${C.reset} ${C.bold}Codex${C.reset}                          ${C.bold}${C.cyan}│${C.reset}`,
    `  ${C.bold}${C.cyan}│${C.reset}  ${C.dim}native push messaging for AI agents${C.reset}        ${C.bold}${C.cyan}│${C.reset}`,
    `  ${C.bold}${C.cyan}╰─────────────────────────────────────────────╯${C.reset}`,
    "",
  ];
  if (initialAgent) {
    lines.push(`  ${C.green}●${C.reset} restored session as ${C.bold}@${initialAgent}${C.reset}`);
  } else {
    lines.push(
      `  ${C.yellow}●${C.reset} ${C.dim}no agent session yet — paste a chat onboarding prompt inside Codex${C.reset}`,
      `  ${C.dim}(MCP will call agent_login(token) automatically)${C.reset}`,
    );
  }
  lines.push(
    `  ${C.gray}backend${C.reset}  ${BACKEND_WS_URL}`,
    `  ${C.gray}log${C.reset}      ${LOG_FILE}`,
    "",
    `  ${C.dim}Codex TUI starts below. /exit to quit.${C.reset}`,
    "",
  );
  process.stderr.write(lines.join("\n") + "\n");
}

const initialSession = readSession();
printBanner(initialSession?.name ?? null);

// Mutable identity — picked up from session file at startup, refreshed on
// every change. `null` means "no active agent yet, defer backend WS".
let activeAuthToken = initialSession?.token ?? null;
let activeAgentName = initialSession?.name ?? null;

// ---------------------------------------------------------------------------
// 1. Spawn codex app-server, capture port
// ---------------------------------------------------------------------------
const server = spawn("codex", ["app-server", "--listen", "ws://127.0.0.1:0"], {
  stdio: ["ignore", "pipe", "pipe"],
  shell: platform() === "win32",
});

server.on("error", (err) => {
  process.stderr.write(
    `[inbetween-codex] failed to spawn codex app-server: ${err.message}\n` +
      `is \`codex\` in PATH? Try: codex --version\n`,
  );
  process.exit(1);
});

server.on("exit", (code) => {
  log(`codex app-server exited (${code})`);
});

let appServerPort = null;
let onAppServerReadyCalled = false;
const rl = createInterface({ input: server.stderr });
rl.on("line", (line) => {
  log("[codex-server]", line);
  const m = line.match(/127\.0\.0\.1:(\d+)/);
  if (m && !appServerPort) {
    appServerPort = Number(m[1]);
    if (!onAppServerReadyCalled) {
      onAppServerReadyCalled = true;
      onAppServerReady();
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Once app-server is up: connect ourselves, then spawn TUI inline
// ---------------------------------------------------------------------------
async function onAppServerReady() {
  log(`app-server listening on ws://127.0.0.1:${appServerPort}`);

  // 2a. Open our connection to the app-server.
  const appWs = new WebSocket(`ws://127.0.0.1:${appServerPort}`);
  let nextId = 1;
  const pending = new Map();
  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      appWs.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  // State.
  let activeThreadId = null;
  const messageQueue = [];

  // Dedup: avoid re-injecting messages that backend replays after a WS
  // reconnect. Tracks last N seen message_ids.
  const seenMessageIds = new Set();
  const SEEN_MAX = 500;
  function markSeen(id) {
    if (!id) return;
    seenMessageIds.add(id);
    if (seenMessageIds.size > SEEN_MAX) {
      const toDrop = seenMessageIds.size - SEEN_MAX / 2;
      let i = 0;
      for (const k of seenMessageIds) {
        if (i++ >= toDrop) break;
        seenMessageIds.delete(k);
      }
    }
  }

  async function deliverToCodex(item) {
    if (!activeThreadId) {
      messageQueue.push(item);
      log(`queued message from @${item.from} (no active thread yet)`);
      return;
    }
    if (item.message_id && seenMessageIds.has(item.message_id)) {
      log(`skip duplicate message_id=${item.message_id}`);
      return;
    }
    markSeen(item.message_id);
    const text = `[InBetween from @${item.from}]: ${item.content}`;
    try {
      await rpc("turn/start", {
        threadId: activeThreadId,
        input: [{ type: "text", text }],
      });
      log(`delivered msg from @${item.from} → turn/start`);
    } catch (e) {
      const msg = JSON.stringify(e);
      if (
        msg.includes("ActiveTurn") ||
        msg.includes("active") ||
        msg.includes("busy")
      ) {
        try {
          await rpc("turn/steer", {
            threadId: activeThreadId,
            input: [{ type: "text", text }],
          });
          log(`delivered msg from @${item.from} → turn/steer (turn was busy)`);
        } catch (e2) {
          log("failed to steer:", JSON.stringify(e2));
        }
      } else {
        log("failed to start turn:", msg);
      }
    }
  }

  appWs.on("open", async () => {
    try {
      await rpc("initialize", {
        clientInfo: { name: "inbetween-codex", version: "0.1.0" },
        capabilities: {},
      });
      log("app-server initialized");
      // Now that our control plane is connected, launch the TUI in this
      // same terminal. It will create a thread, fire thread/started, and
      // the message handler will pick up the threadId.
      spawnTuiInline(appServerPort);
    } catch (e) {
      log("initialize failed:", JSON.stringify(e));
    }
  });

  appWs.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }
    if (msg.method === "thread/started" && msg.params?.thread?.id) {
      const newId = msg.params.thread.id;
      if (newId !== activeThreadId) {
        activeThreadId = newId;
        log(`active thread = ${newId} (queued: ${messageQueue.length})`);
        while (messageQueue.length > 0) {
          const item = messageQueue.shift();
          await deliverToCodex(item);
        }
      }
    }
  });

  appWs.on("close", () => {
    log("app-server WS closed");
  });
  appWs.on("error", (e) => log("app-server WS error:", e.message));

  // ---------------------------------------------------------------------------
  // 3. Watch session file → connect/reconnect to backend on identity change
  // ---------------------------------------------------------------------------
  let backendWs = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  const HEARTBEAT_MS = 15000;

  function teardownBackend() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (backendWs) {
      try {
        backendWs.removeAllListeners();
        backendWs.close();
      } catch {}
      backendWs = null;
    }
  }

  function connectBackend() {
    if (!activeAuthToken) {
      log("no token yet, deferring backend connection");
      return;
    }
    log(`connecting to backend ${BACKEND_WS_URL} as @${activeAgentName}`);
    const tokenAtConnect = activeAuthToken;
    backendWs = new WebSocket(BACKEND_WS_URL, {
      headers: { Authorization: `Bearer ${tokenAtConnect}` },
    });

    backendWs.on("open", () => {
      log(`backend connected as @${activeAgentName}`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (backendWs?.readyState === WebSocket.OPEN) {
          backendWs.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, HEARTBEAT_MS);
    });

    backendWs.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (event.type === "new_message") {
        const fromHuman = !!event.from_human;
        const sender = fromHuman
          ? `human(@${event.from_agent})`
          : event.from_agent;
        deliverToCodex({
          from: sender,
          content: event.content || "",
          message_id: event.message_id,
        });
      } else if (event.type === "new_messages_batch") {
        for (const m of event.messages || []) {
          const sender = m.from_human
            ? `human(@${m.from_agent})`
            : m.from_agent;
          deliverToCodex({
            from: sender,
            content: m.content || "",
            message_id: m.message_id,
          });
        }
      }
    });

    backendWs.on("close", (code, reason) => {
      log(`backend WS closed (code=${code} reason=${reason || "-"}); reconnecting in 3s`);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Only auto-reconnect if the token hasn't changed; otherwise the
      // session-file watcher will trigger a fresh connect.
      if (activeAuthToken === tokenAtConnect && activeAuthToken) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (activeAuthToken === tokenAtConnect && activeAuthToken) connectBackend();
        }, 3000);
      }
    });
    backendWs.on("error", (e) => log(`backend WS error: ${e.message}`));
  }

  function refreshIdentityFromDisk() {
    const session = readSession();
    const newToken = session?.token ?? null;
    const newName = session?.name ?? null;
    if (newToken === activeAuthToken && newName === activeAgentName) return;
    log(`session changed: @${activeAgentName} → @${newName}`);
    activeAuthToken = newToken;
    activeAgentName = newName;
    teardownBackend();
    if (activeAuthToken) connectBackend();
  }

  // Initial connect if we already have a token.
  if (activeAuthToken) connectBackend();

  // Watch the sessions dir for the file appearing/changing. fs.watch is
  // chatty on Windows (multiple events per write), so debounce.
  let watchDebounce = null;
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    watch(SESSION_DIR, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (filename === `${cwdHash}.json`) {
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(refreshIdentityFromDisk, 250);
      }
    });
  } catch (e) {
    log(`session watcher failed: ${e.message}; falling back to 5s poll`);
    setInterval(refreshIdentityFromDisk, 5000);
  }
}

// ---------------------------------------------------------------------------
// Spawn TUI inline — same terminal, no second window.
// ---------------------------------------------------------------------------
function spawnTuiInline(port) {
  const args = [
    "--remote",
    `ws://127.0.0.1:${port}`,
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  log(`launching TUI inline: codex ${args.join(" ")}`);
  const tui = spawn("codex", args, {
    stdio: "inherit",
    shell: platform() === "win32",
  });
  tui.on("error", (err) => {
    process.stderr.write(`\n[inbetween-codex] failed to launch TUI: ${err.message}\n`);
    process.exit(1);
  });
  tui.on("exit", (code) => {
    log(`TUI exited (code=${code})`);
    try {
      server.kill();
    } catch {}
    process.exit(code ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
process.on("SIGINT", () => {
  log("SIGINT received, stopping");
  try {
    server.kill();
  } catch {}
  process.exit(0);
});
