# Kilo Remote Agent

Kilo Remote Agent is a Cursor-style AI coding agent for VS Code Remote SSH,
network-restricted Linux servers, offline development environments, and
remote workspaces without Internet access.

The local Controller keeps the agent loop, LLM provider, model requests,
session state, and API credentials on the local workstation. This workspace
extension runs on the Remote SSH host and routes workspace operations to the
remote execution boundary.

## Install

For normal online installation, install the **Kilo Remote Agent** Extension
Pack from the VS Code Marketplace. It installs the three runtime components:

- `hainuo-wang.kilo-remote-agent` — Remote SSH workspace integration;
- `hainuo-wang.kilo-remote-agent-controller` — local model and credential controller;
- `hainuo-wang.kilo-remote-agent-worker` — remote filesystem, processes, PTY, and command execution.

For an offline or network-restricted environment, download the single-file
Installer VSIX from the GitHub Release. Install the same Installer VSIX once
in the local VS Code window and once in the Remote SSH window. It installs
the Controller locally and the Main Agent plus Worker remotely.

## Architecture

```text
Local workstation
  Agent loop · LLM provider · SecretStorage · local kilo serve
                         │
                         │ VS Code Remote SSH command transport
                         ▼
Remote Linux workspace
  Filesystem · shell · PTY · processes · Python · pytest · Git · CUDA
```

The remote server does not receive the local API key and does not need
Internet access to reach the model provider. The project does not create an
additional SSH connection, use `ssh -R`, or bypass the authentication and
MFA flow managed by VS Code Remote SSH.

## Configuration

Enable the experimental architecture in local User settings:

```json
{
  "kilo-code.new.experimental.cursorLikeRemote": true,
  "kilo-code.new.experimental.duckcoding.baseURL": "https://api.duckcoding.ai/v1",
  "kilo-code.new.experimental.duckcoding.model": "gpt-5.6-sol",
  "kilo-code.new.experimental.duckcoding.api": "responses"
}
```

Configure the key only from the local Command Palette:

```text
Kilo: Configure Local DuckCoding API Key
```

The key is stored in local VS Code `SecretStorage` under
`duckcoding.apiKey`. Do not put it in the workspace, remote settings, remote
environment, or shell commands.

## Documentation

See the repository [README](https://github.com/hainuo-wang/Kilo-Remote-Agent)
for installation details, offline verification, Remote SSH disconnect
handling, and the upstream synchronization strategy.

## License

MIT. This project is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.
