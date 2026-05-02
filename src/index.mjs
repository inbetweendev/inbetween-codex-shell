#!/usr/bin/env node
/**
 * inbetween-codex — wrapper around Codex CLI that delivers InBetween messages
 * directly into the live conversation via codex app-server JSON-RPC.
 *
 * Architecture:
 *   1. Spawn `codex app-server --listen ws://127.0.0.1:0` (background).
 *   2. Spawn `codex --remote ws://127.0.0.1:PORT` in a NEW terminal window
 *      (so the user gets a clean TUI without our logs interfering).
 *   3. Open WS to the app-server, listen for `thread/started` from the TUI,
 *      capture its threadId.
 *   4. Open WS to the InBetween backend (using auth_token from config).
 *   5. When backend sends `new_message` → `turn/start` in the active Codex
 *      thread, prefixed `[InBetween from @<sender>]: ...`. Codex renders it
 *      in scrollback and the model treats it as conversation context.
 *
 * Config: reads ~/.inbetween/config.json (or AGENTGRAM_* legacy paths).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
function resolveConfigPath() {
  const explicit =
    process.env.INBETWEEN_CONFIG_PATH || process.env.AGENTGRAM_CONFIG_PATH;
  if (explicit) return explicit;
  const localPath = join(process.cwd(), ".inbetween", "config.json");
  if (existsSync(localPath)) return localPath;
  const newPath = join(homedir(), ".inbetween", "config.json");
  if (existsSync(newPath)) return newPath;
  return join(homedir(), ".agentgram", "config.json");
}

const CONFIG_PATH = resolveConfigPath();
let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch (e) {
  console.error(
    `[inbetween-codex] config not found at ${CONFIG_PATH}. ` +
      `Run: npx -y @inbetweenai/install --token <agent_code>`
  );
  process.exit(1);
}

const BACKEND_WS_URL =
  process.env.INBETWEEN_WS_URL ||
  process.env.AGENTGRAM_WS_URL ||
  config.ws_url;
const AUTH_TOKEN = config.auth_token;
const AGENT_NAME = config.agent_name || "unknown";

// ANSI helpers (no chalk dep — keep zero deps beyond ws).
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

function printBanner() {
  const lines = [
    "",
    `  ${C.bold}${C.cyan}╭─────────────────────────────────────────────╮${C.reset}`,
    `  ${C.bold}${C.cyan}│${C.reset}  ${C.bold}InBetween${C.reset} ${C.dim}×${C.reset} ${C.bold}Codex${C.reset}                          ${C.bold}${C.cyan}│${C.reset}`,
    `  ${C.bold}${C.cyan}│${C.reset}  ${C.dim}native push messaging for AI agents${C.reset}      ${C.bold}${C.cyan}│${C.reset}`,
    `  ${C.bold}${C.cyan}╰─────────────────────────────────────────────╯${C.reset}`,
    "",
    `  ${C.green}●${C.reset} connected as ${C.bold}@${AGENT_NAME}${C.reset}`,
    `  ${C.gray}backend${C.reset}  ${BACKEND_WS_URL}`,
    `  ${C.gray}config${C.reset}   ${CONFIG_PATH}`,
    "",
    `  ${C.dim}Codex TUI will open in a new window.${C.reset}`,
    `  ${C.dim}Incoming InBetween messages appear in scrollback as${C.reset}`,
    `  ${C.dim}\`[InBetween from @<sender>]: ...\`${C.reset}`,
    "",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

printBanner();

// ---------------------------------------------------------------------------
// 1. Spawn codex app-server, capture port
// ---------------------------------------------------------------------------

const server = spawn("codex", ["app-server", "--listen", "ws://127.0.0.1:0"], {
  stdio: ["ignore", "pipe", "pipe"],
  shell: platform() === "win32",
});

server.on("error", (err) => {
  console.error(`[inbetween-codex] failed to spawn codex: ${err.message}`);
  console.error("[inbetween-codex] is `codex` in PATH? Try: codex --version");
  process.exit(1);
});

server.on("exit", (code) => {
  console.error(`[inbetween-codex] codex app-server exited (${code})`);
  process.exit(code ?? 1);
});

let appServerPort = null;
const rl = createInterface({ input: server.stderr });
rl.on("line", (line) => {
  // Forward server logs to stderr so user can see them, but don't pollute stdout.
  console.error("[codex-server]", line);
  const m = line.match(/127\.0\.0\.1:(\d+)/);
  if (m && !appServerPort) {
    appServerPort = Number(m[1]);
    onAppServerReady();
  }
});

// ---------------------------------------------------------------------------
// 2. Once app-server is up: spawn TUI in new window + connect ourselves
// ---------------------------------------------------------------------------
async function onAppServerReady() {
  console.error(`[inbetween-codex] app-server on ws://127.0.0.1:${appServerPort}`);

  // 2a. Spawn the TUI in a fresh terminal window so it has a clean tty.
  spawnTuiWindow(appServerPort);

  // 2b. Open our own connection to the app-server.
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

  // State: which thread to inject into (set when TUI creates one).
  let activeThreadId = null;
  // Queue of pending InBetween messages until a thread exists.
  const messageQueue = [];

  async function injectBootContext() {
    const text =
      `[InBetween — session bootstrap]\n` +
      `\n` +
      `You are running inside an InBetween-Codex session as agent ` +
      `\`@${AGENT_NAME}\`. InBetween is a messaging layer that lets AI ` +
      `agents send each other text messages.\n` +
      `\n` +
      `Rules for the rest of this session:\n` +
      `1. When a message starting with \`[InBetween — incoming message ` +
      `from @<name>]\` appears in the conversation, treat it as a ` +
      `notification that another agent wrote to you.\n` +
      `2. Do NOT auto-reply to such messages. Acknowledge them only if ` +
      `the sender asked a direct question, or the human user (this ` +
      `terminal's owner) tells you to respond.\n` +
      `3. To send messages to other agents, use the inbetween MCP tools ` +
      `(\`send_message\`, \`list_chats\`, \`chat_send\`, etc.).\n` +
      `4. If the human gives you a task, focus on the task — InBetween ` +
      `messages are background context, not interrupts.\n` +
      `\n` +
      `(This bootstrap message is auto-injected once per session by ` +
      `\`inbetween-codex\`. Reply with a single word like \`ready\` if you ` +
      `understood, otherwise just continue.)`;
    try {
      await rpc("turn/start", {
        threadId: activeThreadId,
        input: [{ type: "text", text }],
      });
      console.error("[inbetween-codex] boot context injected");
    } catch (e) {
      console.error(
        "[inbetween-codex] boot context inject failed:",
        JSON.stringify(e)
      );
    }
  }

  async function deliverToCodex(item) {
    if (!activeThreadId) {
      messageQueue.push(item);
      console.error(
        `[inbetween-codex] queued message from @${item.from} (no active thread yet)`
      );
      return;
    }
    const text =
      `[InBetween — incoming message from @${item.from}]\n` +
      `${item.content}\n` +
      `\n(This is an InBetween auto-delivered message. Do NOT reply ` +
      `unless the sender directly asks you a question. If you do reply, ` +
      `use the inbetween MCP \`send_message\` tool — do not type the reply ` +
      `into your own scratchpad.)`;
    try {
      await rpc("turn/start", {
        threadId: activeThreadId,
        input: [{ type: "text", text }],
      });
      console.error(
        `[inbetween-codex] delivered msg from @${item.from} → turn/start`
      );
    } catch (e) {
      const msg = JSON.stringify(e);
      // Already an active turn — try steering instead.
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
          console.error(
            `[inbetween-codex] delivered msg from @${item.from} → turn/steer (turn was busy)`
          );
        } catch (e2) {
          console.error(
            `[inbetween-codex] failed to steer: ${JSON.stringify(e2)}`
          );
        }
      } else {
        console.error(`[inbetween-codex] failed to start turn: ${msg}`);
      }
    }
  }

  appWs.on("open", async () => {
    try {
      await rpc("initialize", {
        clientInfo: { name: "inbetween-codex", version: "0.0.1" },
        capabilities: {},
      });
      console.error("[inbetween-codex] app-server initialized");
    } catch (e) {
      console.error(
        "[inbetween-codex] initialize failed:",
        JSON.stringify(e)
      );
    }
  });

  appWs.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Resolve pending RPC responses.
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }
    // Watch for the TUI creating a thread — that becomes our injection target.
    if (msg.method === "thread/started" && msg.params?.thread?.id) {
      const newId = msg.params.thread.id;
      if (newId !== activeThreadId) {
        const isFirstThread = activeThreadId === null;
        activeThreadId = newId;
        console.error(
          `[inbetween-codex] active thread = ${newId} (drained ${messageQueue.length} queued)`
        );
        // On the very first thread, inject a boot context message that
        // establishes who Codex is in the InBetween network and how it
        // should treat incoming `[InBetween from @X]` messages.
        if (isFirstThread) {
          await injectBootContext();
        }
        // Drain any messages that arrived before TUI started.
        while (messageQueue.length > 0) {
          const item = messageQueue.shift();
          await deliverToCodex(item);
        }
      }
    }
  });

  appWs.on("close", () => {
    console.error("[inbetween-codex] app-server WS closed");
    process.exit(0);
  });
  appWs.on("error", (e) =>
    console.error(`[inbetween-codex] app-server WS error: ${e.message}`)
  );

  // ---------------------------------------------------------------------------
  // 3. Connect to InBetween backend, route incoming messages → Codex
  // ---------------------------------------------------------------------------
  let backendWs = null;
  let reconnectTimer = null;

  function connectBackend() {
    console.error(`[inbetween-codex] connecting to backend ${BACKEND_WS_URL}`);
    backendWs = new WebSocket(BACKEND_WS_URL, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    backendWs.on("open", () => {
      console.error(`[inbetween-codex] backend connected as @${AGENT_NAME}`);
      // Heartbeat
      setInterval(() => {
        if (backendWs.readyState === WebSocket.OPEN) {
          backendWs.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, 30000);
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
      // Ignore heartbeat_ack, wake, task_created etc. for now.
    });

    backendWs.on("close", () => {
      console.error("[inbetween-codex] backend WS closed, reconnecting in 3s");
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectBackend, 3000);
    });
    backendWs.on("error", (e) =>
      console.error(`[inbetween-codex] backend WS error: ${e.message}`)
    );
  }

  connectBackend();
}

// ---------------------------------------------------------------------------
// Spawn TUI in a new terminal window so its stdio is clean.
// ---------------------------------------------------------------------------
function spawnTuiWindow(port) {
  const cmd = `codex --remote ws://127.0.0.1:${port}`;
  const os = platform();
  console.error(`[inbetween-codex] launching TUI: ${cmd}`);

  const title = `InBetween × Codex — @${AGENT_NAME}`;

  if (os === "win32") {
    spawn("cmd", ["/c", "start", title, "cmd", "/k", cmd], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
  } else if (os === "darwin") {
    const escaped = cmd.replace(/"/g, '\\"');
    spawn(
      "osascript",
      ["-e", `tell app "Terminal" to do script "${escaped}"`],
      { detached: true, stdio: "ignore" }
    );
  } else {
    // Linux: try common terminals.
    const candidates = [
      ["gnome-terminal", ["--", "bash", "-c", `${cmd}; exec bash`]],
      ["konsole", ["-e", "bash", "-c", `${cmd}; exec bash`]],
      ["xterm", ["-hold", "-e", "bash", "-c", cmd]],
    ];
    for (const [bin, args] of candidates) {
      try {
        spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
        return;
      } catch {}
    }
    console.error(
      `[inbetween-codex] could not find a terminal. Run manually:\n  ${cmd}`
    );
  }
}

// Cleanup
process.on("SIGINT", () => {
  console.error("\n[inbetween-codex] stopping...");
  server.kill();
  process.exit(0);
});
