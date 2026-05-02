# inbetween-codex (PoC)

Wrapper around Codex CLI that injects InBetween messages directly into the
running conversation via Codex's `app-server` JSON-RPC protocol +
`thread/inject_items` method.

## Run the proof-of-concept

```bash
cd codex-shell
npm install
node src/poc.mjs
```

The script will:
1. Spawn `codex app-server --listen ws://127.0.0.1:0` and read the chosen port.
2. Print a command — open a **second terminal** and run it:
   ```
   codex --remote ws://127.0.0.1:<PORT>
   ```
   This launches the normal Codex TUI but attached to our app-server.
3. Send `initialize` + `thread/start`, then every 5 seconds inject a fresh
   `[InBetween test N]` message into the active thread.

**Expected:** every 5 seconds a new line `[InBetween test N] message injected at ...`
appears in the Codex TUI scrollback **without you typing anything**.

If that works — the proof is done and we can build the real wrapper that
hooks into the InBetween backend WebSocket.
