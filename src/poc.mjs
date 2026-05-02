#!/usr/bin/env node
/**
 * InBetween-Codex PoC.
 *
 * Goal: prove that `codex app-server` + `thread/inject_items` can deliver
 * a message into Codex TUI scrollback in real time.
 *
 * What this script does:
 *  1. Spawns `codex app-server --listen ws://127.0.0.1:0` (port 0 = OS picks).
 *  2. Reads the chosen port from server stderr.
 *  3. Prints the exact `codex --remote ws://127.0.0.1:PORT` command for you to run
 *     in a SECOND terminal window (so you see the TUI yourself).
 *  4. Opens its own WS to the app-server, sends `initialize`, `thread/start`.
 *  5. Every 5 seconds injects a fresh `[InBetween test N]` user message into
 *     the active thread. You should see it appear in the Codex TUI scrollback.
 *
 * Press Ctrl+C to stop.
 *
 * Run:   node src/poc.mjs
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// 1. Spawn codex app-server
// ---------------------------------------------------------------------------
console.error("[poc] starting `codex app-server --listen ws://127.0.0.1:0` ...");
const server = spawn("codex", ["app-server", "--listen", "ws://127.0.0.1:0"], {
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32", // Windows resolves `codex.cmd` via shell
});

server.on("error", (err) => {
  console.error("[poc] failed to spawn codex:", err.message);
  console.error("[poc] is `codex` in PATH?  Run `codex --version` to verify.");
  process.exit(1);
});

server.on("exit", (code) => {
  console.error(`[poc] codex app-server exited with code ${code}`);
  process.exit(code ?? 1);
});

// ---------------------------------------------------------------------------
// 2. Wait for port from stderr
// ---------------------------------------------------------------------------
let port = null;
const rl = createInterface({ input: server.stderr });
rl.on("line", (line) => {
  console.error("[codex-server]", line);
  // We don't know the exact log format yet — try several patterns.
  const m =
    line.match(/127\.0\.0\.1:(\d+)/) ||
    line.match(/listening.*?:(\d+)/i) ||
    line.match(/port[=: ]+(\d+)/i);
  if (m && !port) {
    port = Number(m[1]);
    onPortReady();
  }
});

// Also forward server stdout (probably empty for ws transport, but just in case).
server.stdout.on("data", (chunk) =>
  console.error("[codex-server-stdout]", chunk.toString().trimEnd())
);

// ---------------------------------------------------------------------------
// 3. Connect to app-server, run protocol
// ---------------------------------------------------------------------------
async function onPortReady() {
  console.error("\n========================================================");
  console.error(`[poc] app-server listening on ws://127.0.0.1:${port}`);
  console.error("[poc] OPEN A SECOND TERMINAL AND RUN:");
  console.error(`      codex --remote ws://127.0.0.1:${port}`);
  console.error("========================================================\n");

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let nextId = 1;
  const pending = new Map();

  function rpc(method, params = {}) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }

  // Track threadId from the TUI (or any other client). We do NOT create our own
  // thread — we wait for one to appear, then inject into it.
  let activeThreadId = null;
  let injectCount = 0;

  async function injectTick() {
    if (!activeThreadId) {
      console.error("[poc] no active thread yet — start TUI to create one");
      return;
    }
    injectCount++;
    const text = `[InBetween test ${injectCount}] injected at ${new Date().toISOString()}`;
    // Use turn/start instead of thread/inject_items — start triggers item/started
    // events that the TUI renders in scrollback. inject_items only persists,
    // doesn't render.
    try {
      const res = await rpc("turn/start", {
        threadId: activeThreadId,
        input: [{ type: "text", text }],
      });
      console.error(
        `[poc] turn/start #${injectCount} into ${activeThreadId.slice(0, 8)}… ok: ${JSON.stringify(res).slice(0, 80)}`
      );
    } catch (e) {
      const msg = JSON.stringify(e);
      // If a turn is already active, try to steer instead.
      if (msg.includes("ActiveTurn") || msg.includes("active") || msg.includes("busy")) {
        try {
          const res2 = await rpc("turn/steer", {
            threadId: activeThreadId,
            input: [{ type: "text", text }],
          });
          console.error(
            `[poc] turn/steer #${injectCount} ok: ${JSON.stringify(res2).slice(0, 80)}`
          );
        } catch (e2) {
          console.error(`[poc] turn/steer #${injectCount} FAILED:`, JSON.stringify(e2));
        }
      } else {
        console.error(`[poc] turn/start #${injectCount} FAILED:`, msg);
      }
    }
  }

  ws.on("open", async () => {
    console.error("[poc] WS open");
    try {
      const init = await rpc("initialize", {
        clientInfo: { name: "inbetween-codex-poc", version: "0.0.1" },
        capabilities: {},
      });
      console.error("[poc] initialized. Waiting for TUI to create a thread...");
      console.error("[poc] (run `codex --remote ws://127.0.0.1:" + port + "` in another terminal)");

      // Inject every 5s — but only when we have a TUI thread.
      setInterval(injectTick, 5000);
    } catch (e) {
      console.error("[poc] handshake error:", JSON.stringify(e));
    }
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error("[poc] non-JSON frame:", data.toString().slice(0, 200));
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }
    // Notification or unsolicited event.
    // Watch for `thread/started` from the TUI — that's the thread we want to inject into.
    if (msg.method === "thread/started" && msg.params?.thread?.id) {
      const newId = msg.params.thread.id;
      if (newId !== activeThreadId) {
        activeThreadId = newId;
        console.error(`[poc] >>> active thread switched to ${newId} (TUI's thread)`);
      }
    }
    const preview = JSON.stringify(msg).slice(0, 200);
    console.error("[poc] event:", preview);
  });

  ws.on("close", () => {
    console.error("[poc] WS closed");
    process.exit(0);
  });

  ws.on("error", (e) => console.error("[poc] WS error:", e.message));
}

// Cleanup on Ctrl+C
process.on("SIGINT", () => {
  console.error("\n[poc] stopping...");
  server.kill();
  process.exit(0);
});
