# Kilo Remote Agent Worker

This package is the workspace-side companion for the Cursor-like Remote SSH
prototype. It must be installed in the VS Code Remote SSH extension host, not
only on the local machine.

The extension starts:

```text
kilo remote-worker --stdio --root <remote-workspace>
```

It only activates when `vscode.env.remoteName` is set and
`kilo-code.new.experimental.cursorLikeRemote` is enabled. Installing this
companion therefore does not change ordinary local workspaces.

The CLI path is resolved in this order:

1. `kilo-code.remoteWorker.cliPath`
2. `KILO_REMOTE_WORKER_CLI`
3. `bin/kilo` bundled in this extension
4. `bin/kilo` from the main Kilo extension
5. `kilo` on the remote `PATH`

The worker never receives model provider configuration or API credentials. It
only receives versioned filesystem and process RPC messages.

For a Linux development VSIX with a bundled CLI, build the matching opencode
artifact first and run:

```bash
KILO_REMOTE_WORKER_TARGET=linux-x64 bun run package
```

The resulting extension is installed in the VS Code Remote SSH extension host.
