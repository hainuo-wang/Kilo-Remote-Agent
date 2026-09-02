# Cursor-like Remote SSH prototype

This prototype keeps the existing Kilo extension behavior for ordinary local
and Remote SSH workspaces. The main extension is explicitly marked
`extensionKind: ["workspace"]`: VS Code runs it in the local extension host
when no remote extension host exists, and in the Remote SSH extension host when
one does.

## Placement

The main `kilo-code` extension declares `extensionKind: ["workspace"]`. The
experimental controller companion declares `extensionKind: ["ui"]`, so it runs
in the local UI extension host. The remote worker companion declares
`extensionKind: ["workspace"]`, so it runs in the Remote SSH extension host.

When `kilo-code.new.experimental.cursorLikeRemote` is enabled in an `ssh-remote*`
window:

```text
Local UI extension
  ├── local kilo serve
  ├── Mioffice provider and SecretStorage
  ├── Agent loop and session state
  └── localhost authenticated worker bridge
          │
          └── VS Code command RPC
                │
Remote workspace extension
  └── kilo remote-worker --stdio
        ├── workspace filesystem
        ├── grep/list
        ├── process stdout/stderr
        └── PTY
```

The remote main extension's SDK requests use a command-RPC HTTP/SSE proxy to
the local controller. The existing HTTP/SSE API is therefore preserved; no
second SSH connection, reverse port forward, SOCKS proxy, or HTTP proxy is
created.

## Credential boundary

The Mioffice key is stored in the local controller extension's VS Code
`SecretStorage` under `mioffice.apiKey`. It is injected only into the local
`kilo serve` environment. It is not included in:

- workspace files;
- remote worker environment;
- worker RPC parameters;
- command-RPC HTTP parameters; or
- remote process environments.

The Mioffice protocol defaults to the OpenAI Responses API. Set
`kilo-code.new.experimental.mioffice.api` to `chat` when the compatible
endpoint only exposes Chat Completions. Both protocols execute inside the
local controller.

The worker and process implementation also remove known controller credential
variables as defense in depth.

Requests whose URL is the local Kilo backend origin use the controller fetcher
and therefore stay on the local side. Marketplace downloads and arbitrary
external provider model catalogs remain outside this PoC and keep their
existing direct-fetch behavior; they are not part of the Mioffice credential
path and are not treated as Remote SSH-safe services.

## Current PoC scope

The remote tool overlay currently routes `read`, `write`, `edit`, `glob`,
`grep`, and `bash`. The worker protocol additionally exposes `stat`, process
streaming, and PTY operations. The first PoC validates process streaming
through the Agent tool path; the existing Agent Manager terminal-tab UI still
uses its legacy backend PTY WebSocket and is not yet enabled as a Remote
Worker terminal. Git, indexing, LSP, diagnostics, MCP placement, and other
workspace-sensitive services remain follow-up work and must not be treated as
remote-safe until explicitly routed.

## Packaging

Install the main extension, the local controller companion, and the remote
worker companion manually. The main extension intentionally does not declare
hard `extensionDependencies` on the private PoC companions, so an ordinary
Kilo installation remains unchanged and the companions can be omitted
entirely. The worker package must be installed in the Remote SSH extension
host. The controller package must be installed locally.

The controller package includes a platform-matched local CLI when packaged
with `bun run package` after building the matching opencode artifact. During
development, use `kilo-code.remoteController.cliPath` for an external local
CLI path. The worker package follows the same pattern with
`kilo-code.remoteWorker.cliPath`.

## Upstream upgrade strategy

The prototype keeps the upstream Agent loop, Provider implementations, SDK
schema, and generated client intact. Kilo-specific integration is concentrated
in:

- `packages/kilo-remote-protocol/`;
- the two companion extensions;
- `packages/opencode/src/kilocode/remote-worker/`;
- the `remote-worker` CLI registration; and
- a small set of marked routing and tool-registry hooks in
  `packages/opencode/`.

When updating from `origin/main`:

1. Rebase the branch and resolve only the marked shared-file hunks.
2. Leave generated SDK files and upstream Agent/Provider changes untouched.
3. Run the remote-worker tests, package type checks, and the
   `check-opencode-annotations` verifier.
4. Rebuild the platform-matched CLI artifacts before packaging the companion
   VSIX files.

The experiment remains disabled by default, and the main extension does not
depend on either companion. An upstream update therefore does not require
installing or changing the Remote SSH prototype for ordinary local workspaces.

## Local validation

Use the following settings in User settings or a profile settings file. Do not
put the API key in settings, the workspace, or a remote environment:

```json
{
  "kilo-code.new.experimental.cursorLikeRemote": true,
  "kilo-code.new.experimental.mioffice.baseURL": "https://api.llm.mioffice.cn/v1",
  "kilo-code.new.experimental.mioffice.model": "ppio/pa/gpt-5.6-sol",
  "kilo-code.new.experimental.mioffice.api": "responses"
}
```

Install the main extension and the two companion VSIX files. Install the
controller VSIX in the local extension host and the worker VSIX in the Remote
SSH extension host. Then run `Kilo: Configure Local Mioffice API Key`; the
value is stored in local `SecretStorage`. Reload the window after changing the
key and run `Kilo: Run Remote Worker Smoke Test`.

The smoke test must report the Linux platform and workspace directory, verify
read/write/list/grep, and show complete `stdout` and `stderr`. For the first
Agent test, ask Kilo to read a Python file, make a small edit, run `pytest`,
and then run `git diff`. The command output should identify the remote Linux
workspace, not a Windows path.

On the remote host, verify the credential boundary independently:

```sh
env | grep -i api
curl --connect-timeout 5 https://api.llm.mioffice.cn
```

The first command must not show the Mioffice Team Key, and the second command
should fail in an intentionally offline server environment. Disconnect and
reconnect Remote SSH while a remote command is running; the active operation
should return a remote-disconnect error, the local Agent should remain alive,
and a subsequent smoke test should start a fresh worker.
