# Kilo Remote Agent Controller

This package is the local-side companion for the Cursor-like Remote SSH
prototype. It runs in the local VS Code UI extension host while the main Kilo
extension runs in the workspace host. In a normal local window, VS Code has no
remote extension host, so the workspace extension still executes locally.

When `kilo-code.new.experimental.cursorLikeRemote` is enabled in a Remote SSH
window, this extension owns:

- the local `kilo serve` process;
- the local DuckCoding provider configuration and SecretStorage lookup;
- the authenticated localhost WebSocket bridge used by remote tools; and
- the command-RPC HTTP/SSE proxy used by the remote main extension.

The remote extension host never receives the DuckCoding API key. It only sees
ordinary backend responses and streamed tool output.

Credential-bearing responses are projected before they cross the command route.
Remote config/auth writes containing literal credential values are rejected;
configure DuckCoding in the local controller with `Kilo: Configure Local
DuckCoding API Key`. A custom provider must already be saved in the local
controller before the remote host can discover its models. Existing `mioffice.*`
settings and the `mioffice.apiKey` secret are read as migration fallbacks.

The controller uses the DuckCoding model `gpt-5.6-sol` and OpenAI Responses API
by default. The default API endpoint is `https://api.duckcoding.ai/v1`.
Configure `kilo-code.new.experimental.duckcoding.baseURL` only when using a
different compatible endpoint. Set `kilo-code.new.experimental.duckcoding.api`
to `chat` only for an endpoint that implements OpenAI-compatible Chat
Completions.

If the local machine reaches DuckCoding through a proxy, set
`kilo-code.remoteController.proxy`. The proxy is added only to the local
`kilo serve` environment and is never included in Remote Worker RPC messages or
remote process environments.

The smoke command is available from the Command Palette:

```text
Kilo: Run Remote Worker Smoke Test
```

The command performs remote read/write/list/grep and `process.run` requests.
Output is returned through the reverse VS Code command route and checked
against the byte counts reported by the remote worker. It does not use
`vscode.window.createTerminal()` for output capture.

The prototype deliberately keeps Kilo's existing HTTP/SSE backend and SDK
unchanged. The remote main extension proxies those HTTP/SSE requests through
VS Code commands to the local controller; the local backend then talks to the
remote worker through the same controller's localhost bridge. Agent Manager
embedded terminal tabs use a separate local WebSocket endpoint backed by the
same Remote Worker PTY stream, so terminal output does not depend on
`vscode.window.createTerminal()` capture.

To create a local Windows companion VSIX, build the
`@kilocode/cli-windows-x64` opencode artifact and run:

```bash
KILO_REMOTE_CONTROLLER_TARGET=win32-x64 bun run package
```

The package copies the matching CLI and runtime resources into its own
`bin/` directory, so it does not depend on the main extension being installed
in the local extension host. If the bundled CLI cannot be used during
development, configure `kilo-code.remoteController.cliPath` to an external
local Kilo CLI path.
