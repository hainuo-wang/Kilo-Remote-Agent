# Kilo Code Remote Controller

This package is the local-side companion for the Cursor-like Remote SSH
prototype. It runs in the local VS Code UI extension host while the main Kilo
extension runs in the workspace host. In a normal local window, VS Code has no
remote extension host, so the workspace extension still executes locally.

When `kilo-code.new.experimental.cursorLikeRemote` is enabled in a Remote SSH
window, this extension owns:

- the local `kilo serve` process;
- the local Mioffice provider configuration and SecretStorage lookup;
- the authenticated localhost WebSocket bridge used by remote tools; and
- the command-RPC HTTP/SSE proxy used by the remote main extension.

The remote extension host never receives the Mioffice API key. It only sees
ordinary backend responses and streamed tool output.

The controller uses the OpenAI Responses API by default. Set
`kilo-code.new.experimental.mioffice.api` to `chat` for an endpoint that only
implements OpenAI-compatible Chat Completions.

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
remote worker through the same controller's localhost bridge. The Agent
Manager terminal-tab UI is still outside the PoC path; its migration to the
worker PTY stream requires a separate webview transport change.

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
