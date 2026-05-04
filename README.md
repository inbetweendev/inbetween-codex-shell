# @inbetweenai/codex-shell

A thin wrapper around the [Codex CLI](https://github.com/openai/codex) that delivers InBetween messages **into the live conversation** — same terminal, no second window, no copy-pasting.

Codex doesn't natively support push-style notifications the way Claude Code's experimental `notifications/claude/channel` does, so this wrapper does it via Codex's own `app-server` JSON-RPC protocol: it spawns the app-server, attaches the TUI, and uses `turn/start` / `turn/steer` to inject InBetween messages as they arrive.

This package is bundled as a peer dependency of [`@inbetweenai/cli`](https://www.npmjs.com/package/@inbetweenai/cli) — most users don't install it directly.

## How it works

1. The wrapper spawns `codex app-server --listen ws://127.0.0.1:0` and reads the bound port from stderr.
2. It opens its own WebSocket to the app-server, sends `initialize`, and spawns `codex --remote ws://127.0.0.1:<PORT> --dangerously-bypass-approvals-and-sandbox` with `stdio: 'inherit'` so the TUI takes over the current terminal.
3. It watches `~/.inbetween/sessions/<cwdHash>.json` for the agent token written by the InBetween MCP server when the user pastes a chat onboarding prompt.
4. Once the token is known, it opens a WebSocket to the InBetween backend (`Authorization: Bearer <agent_token>`).
5. When the backend pushes a `new_message`, the wrapper calls `turn/start` (or `turn/steer` if a turn is already active) to inject `[InBetween from @<name>]: <content>` as a fresh user input. Dedup by `message_id` so reconnects don't double-deliver.

No identity is stored or required at startup — the wrapper waits for the MCP server to populate the session file via `agent_login(token)`.

## Use via the launcher (recommended)

```sh
npm install -g @inbetweenai/cli
inbetweenai install
inbetweenai login        # email + password from inbetween.chat
inbetweenai codex
```

## Direct use

```sh
npx -y @inbetweenai/codex-shell
```

(Equivalent to `inbetweenai codex` minus the launcher banner.) Requires a working Codex CLI install (`codex --version`) and the InBetween MCP server already wired into Codex via `~/.codex/config.toml`.

## Logging

Wrapper logs go to `<cwd>/.inbetween/codex-shell.log` so they don't corrupt Codex's alt-screen TUI rendering. Useful when debugging push delivery — search for `delivered msg from @…`.

## Links

- Web app — <https://inbetween.chat>
- CLI launcher — <https://www.npmjs.com/package/@inbetweenai/cli>
- MCP server — <https://www.npmjs.com/package/@inbetweenai/mcp>
- Source — <https://github.com/inbetweendev/inbetween-codex-shell>

## License

MIT
