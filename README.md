# Kilo Remote Agent

**A Cursor-style local-brain/remote-hands coding agent for VS Code Remote SSH, network-restricted Linux servers, offline development environments, and no-internet remote workspaces.**

Kilo Remote Agent lets an AI coding agent use a remote Linux workspace even
when that server cannot access the Internet or the LLM provider. The model
requests, agent loop, tool selection, credentials, and session state stay on
the local computer. Filesystem operations, shell commands, Python, tests,
CUDA workloads, Git commands, PTY sessions, and process execution run on the
remote server.

This project is useful for:

- AI coding on a network-restricted remote server;
- using an LLM or coding agent on an offline Linux server;
- VS Code Remote SSH development where the server has no Internet access;
- corporate, air-gapped, bastion-host, relay, or MFA-protected environments;
- keeping an OpenAI-compatible API key on the local workstation;
- running a local LLM controller with a remote filesystem and terminal;
- Cursor-style remote agent execution without creating another SSH connection.

> **Local brain, remote hands.** The local computer talks to the model; the
> remote computer edits files and executes commands.

Kilo Remote Agent is an independent open-source project based on Kilo Code
and OpenCode. It uses independent extension IDs and is not affiliated with
or automatically upgraded by the official Kilo Code extension.

## Why This Project

The normal assumption of an AI coding tool is that the machine running the
agent can also reach the model API. That assumption fails in many remote
development environments:

```text
Local Windows workstation                 Remote Linux server
Can access the LLM API                    No Internet / restricted network
Stores the API key                        Must not receive the API key
Runs the agent loop                       Runs the workspace tools
```

Kilo Remote Agent separates these responsibilities instead of trying to make
a local extension guess which operating system owns a Remote SSH workspace.
It does not use `vscode.window.createTerminal()` as an output-capture
workaround and does not put the entire `kilo serve` process on the local
machine to access remote paths directly.

## Architecture

```text
Windows or Linux Local
┌─────────────────────────────────────────┐
│ Kilo Remote Agent Controller             │
│                                         │
│ Agent loop and reasoning                 │
│ Prompt/context orchestration             │
│ Provider and model HTTP requests         │
│ Conversation/session state               │
│ API key in VS Code SecretStorage         │
│ Local kilo serve                         │
└──────────────────┬──────────────────────┘
                   │
                   │ VS Code Remote SSH command transport
                   │ No extra SSH connection or ssh -R
                   ▼
Linux Remote SSH Workspace
┌─────────────────────────────────────────┐
│ Kilo Remote Agent + Remote Worker        │
│                                         │
│ Remote filesystem and workspace paths    │
│ read/write/edit/list/glob/grep           │
│ shell and process execution              │
│ PTY and terminal sessions                │
│ stdout/stderr streaming                  │
│ Python, pytest, CUDA, and Git commands   │
└─────────────────────────────────────────┘
```

The three VS Code extensions have separate placement:

| Component | Extension ID | Extension host | Responsibility |
| --- | --- | --- | --- |
| Main Kilo Remote Agent | `hainuo-wang.kilo-remote-agent` | Remote SSH workspace host | Kilo UI, workspace integration, and the existing backend HTTP/SSE client |
| Local Controller | `hainuo-wang.kilo-remote-agent-controller` | Local UI extension host | Agent runtime, model provider, local `kilo serve`, SecretStorage, and transport proxy |
| Remote Worker | `hainuo-wang.kilo-remote-agent-worker` | Remote SSH workspace host | Filesystem, search, processes, PTY, Git-related commands, and output streaming |

In an ordinary local VS Code workspace, the existing local Kilo behavior is
preserved. The Remote SSH architecture is opt-in through
`kilo-code.new.experimental.cursorLikeRemote`.

## Data Flow

The prototype reuses the command transport that VS Code exposes between the
local UI extension host and the Remote SSH workspace extension host. It does
not implement SSH, perform a second login, open `ssh -R`, create a SOCKS
proxy, or give the remote server a general HTTP proxy.

The agent request path is:

```text
User prompt
  ↓
Local Controller agent loop
  ↓
Local DuckCoding/OpenAI-compatible model request
  ↓
Tool selection: read_file, edit_file, grep, run_command, ...
  ↓
VS Code command RPC
  ↓
Remote Worker on the Linux extension host
  ↓
Remote filesystem, shell, PTY, Python, pytest, Git, or CUDA
  ↓
RPC response and streamed stdout/stderr
  ↓
Local Controller aggregates the result and continues reasoning
```

The existing Kilo HTTP/SSE backend is intentionally kept. In experimental
Remote SSH mode, the remote main extension proxies its backend HTTP/SSE
requests through VS Code commands to the local Controller. The Controller's
local backend talks to the Remote Worker through a versioned RPC bridge.
This keeps the shared Agent and Provider implementation close to upstream
Kilo/OpenCode while moving workspace execution to the correct machine.

## Security Model

- LLM HTTP requests originate from the local Controller.
- The API key is stored in local VS Code `SecretStorage`.
- The API key is never written to the workspace, remote settings, remote environment, or remote filesystem.
- The API key is never included in Worker RPC parameters or command-RPC HTTP parameters.
- The Remote Worker receives tool requests and results, not model credentials.
- Remote processes run without the local Controller's credential variables.
- A local HTTP proxy, if configured, affects only the local Controller and is never sent to the remote host.
- The remote server can remain completely offline or unable to resolve the model provider endpoint.
- Existing corporate QR login, password, OTP, relay, bastion, and MFA handling remains owned by VS Code Remote SSH.

This project does not bypass authentication, corporate network controls, or
the security policy of a relay or bastion host.

## Installation

Kilo Remote Agent requires a VS Code Remote SSH connection that already works.
Install the extensions into the correct extension hosts:

### Online installation from the VS Code Marketplace

Install the **Kilo Remote Agent for Remote SSH** Extension Pack. It installs
the three runtime extensions while preserving their separate local and remote
placement:

```text
Marketplace Extension Pack
├── Local Controller
├── Remote SSH Main Agent
└── Remote SSH Worker
```

The Extension Pack is the recommended online installation path. The local VS
Code client needs Marketplace access. VS Code installs each component into its
declared UI or workspace extension host over the existing Remote SSH session;
the remote server does not need access to the model provider.

### Offline or network-restricted installation

For a remote server with no Internet access, download the single-file
Installer VSIX from the GitHub Release:

```text
kilo-remote-agent-installer-<version>.vsix
```

Install this same file twice:

1. In a local VS Code window, install it and run `Kilo Remote Agent: Install Components` to install the local Controller.
2. In the Remote SSH window, upload the same file to the remote workspace, install it there, and run the same command to install the remote Main Agent and Worker.

The Installer VSIX contains the platform-specific component VSIX files and
does not require Marketplace access. It is an installation bootstrapper only;
the three runtime extensions remain independent.

### Windows local + Linux remote

If you are installing the runtime packages manually, download these VSIX files
from the GitHub Release:

```text
kilo-remote-agent-controller-win32-x64.vsix
kilo-remote-agent-linux-x64.vsix
kilo-remote-agent-worker-linux-x64.vsix
```

1. Install `kilo-remote-agent-controller-win32-x64.vsix` in the local Windows VS Code window.
2. Connect to the Linux server with VS Code Remote SSH.
3. In the Remote SSH window, install `kilo-remote-agent-linux-x64.vsix` using `Install in SSH: <host>`.
4. In the same Remote SSH window, install `kilo-remote-agent-worker-linux-x64.vsix`.
5. Enable the experimental architecture in User settings.
6. Reload the VS Code window.

The local Controller and remote Worker are separate VS Code extensions. The
official Kilo Code extension is not required for this independent build. Do
not enable both extensions in the same window because they may register
overlapping Kilo commands.

### VS Code CLI installation

After the Remote SSH host has been configured in VS Code, the three packages
can also be installed with the VS Code CLI:

```powershell
code --install-extension .\kilo-remote-agent-controller-win32-x64.vsix --force
code --remote ssh-remote+YOUR_HOST --install-extension .\kilo-remote-agent-linux-x64.vsix --force
code --remote ssh-remote+YOUR_HOST --install-extension .\kilo-remote-agent-worker-linux-x64.vsix --force
```

Replace `YOUR_HOST` with the SSH `Host` name used by VS Code. This still uses
VS Code Remote SSH and does not replace or bypass its QR, password, OTP, MFA,
relay, or bastion flow.

For a Linux local machine, use
`kilo-remote-agent-controller-linux-x64.vsix` instead of the Windows
Controller package.

## Configuration

Enable the experimental local-controller/remote-worker architecture and
configure the local DuckCoding provider:

```json
{
  "kilo-code.new.experimental.cursorLikeRemote": true,
  "kilo-code.new.experimental.duckcoding.baseURL": "https://api.duckcoding.ai/v1",
  "kilo-code.new.experimental.duckcoding.model": "gpt-5.6-sol",
  "kilo-code.new.experimental.duckcoding.api": "responses"
}
```

The effective provider/model is `duckcoding/gpt-5.6-sol`. The default endpoint
is OpenAI-compatible. `responses` is preferred; use `chat` only when the
configured endpoint provides compatible Chat Completions behavior.

Configure the key from the **local** Command Palette:

```text
Kilo: Configure Local DuckCoding API Key
```

The secret name is `duckcoding.apiKey`. Enter the key in the local VS Code
window, not in the Remote SSH window. It is saved in local
`SecretStorage` and is injected only into the local `kilo serve` process.
Never put the key in `settings.json`, a workspace file, `.env`, a remote
environment variable, or a shell command.

If only the local workstation needs a proxy to reach DuckCoding, configure it
locally:

```json
{
  "kilo-code.remoteController.proxy": "http://127.0.0.1:7897"
}
```

This setting applies only to the local Controller. It is not a proxy for the
remote server and is not transmitted through Worker RPC.

## Verification

First run this command from the VS Code Command Palette:

```text
Kilo: Run Remote Worker Smoke Test
```

Then ask the Agent to perform a remote end-to-end task, for example:

```text
Read a Python file, make a small safe edit, run pytest, show the complete
stdout and stderr, and then run git diff.
```

Verify the following:

- The model request succeeds from the local Windows workstation.
- `pwd` reports the Linux remote workspace, not a Windows path.
- `uname -a`, `python --version`, `pytest`, and `git diff` execute remotely.
- Remote file reads and writes affect the Linux workspace.
- stdout and stderr stream back completely to the local Agent.
- The remote environment does not contain the DuckCoding key:

  ```sh
  env | grep -i api
  ```

- The remote server still cannot access the model provider:

  ```sh
  curl --connect-timeout 5 https://api.duckcoding.ai
  ```

  This should fail in an intentionally offline or network-restricted
  environment.

Disconnect and reconnect Remote SSH during a remote command to verify that
the active Worker operation fails cleanly, the local Controller remains alive,
and a subsequent smoke test creates a fresh Worker connection.

## Current PoC Scope

The first PoC focuses on the local-brain/remote-hands loop:

- `read_file`;
- `write_file` and `edit_file`;
- directory listing, `glob`, and `grep`;
- `run_command` with remote process lifecycle;
- complete stdout/stderr streaming;
- PTY create, input, resize, and close;
- cancellation, timeout, and Remote SSH disconnect handling.

The Agent can therefore read a remote Python file, edit it, run tests on the
remote Linux machine, receive the test output locally, and continue reasoning.
Dedicated Git integration, indexing, LSP, diagnostics, MCP placement, and
additional workspace-sensitive tools require further routing work. A shell
command such as `git diff` already executes on the remote host through the
remote process path.

## Upstream Upgrade Strategy

The project is designed to remain easy to rebase onto future Kilo Code
updates:

- The experimental feature is disabled by default.
- The main Kilo extension does not hard-depend on the companion extensions.
- The shared Agent loop, Provider implementations, SDK schema, and HTTP/SSE API remain as close to upstream as possible.
- Remote-specific protocol code lives in `packages/kilo-remote-protocol/`.
- Local Controller code lives in `packages/kilo-vscode-remote-controller/`.
- Remote Worker code lives in `packages/kilo-vscode-remote-worker/`.
- Worker runtime code lives in `packages/opencode/src/kilocode/remote-worker/`.
- Shared OpenCode changes are kept small and marked for merge tracking where required.

When updating from upstream:

1. Rebase or merge the new Kilo Code `main` changes.
2. Resolve the small, explicitly marked routing and registration hunks first.
3. Keep upstream Agent, Provider, SDK, and generated API changes unless the remote boundary requires an update.
4. Run the remote Worker tests, package type checks, and annotation checks.
5. Rebuild the platform-specific CLI artifacts and companion VSIX packages.
6. Re-run the smoke test against a real VS Code Remote SSH workspace.

This structure avoids a large fork of the core Agent runtime and keeps future
Kilo Code synchronization more manageable.

## Build and Release

Install dependencies:

```bash
bun install
```

Build the runtime components and distribution packages from these directories:

```text
packages/kilo-vscode
packages/kilo-vscode-remote-controller
packages/kilo-vscode-remote-worker
packages/kilo-vscode-remote-installer
packages/kilo-vscode-remote-pack
```

The Controller and Worker packages include a matching Kilo CLI/runtime when
packaged after the corresponding OpenCode artifact has been built. During
development, `kilo-code.remoteController.cliPath` and
`kilo-code.remoteWorker.cliPath` can point to external local or remote CLI
executables.

Pushing a `v*` tag to the `hainuo-wang/Kilo-Remote-Agent` repository triggers
the GitHub Actions workflow that builds and uploads the platform-specific
VSIX packages to a GitHub Release. The workflow does not publish to the VS
Code Marketplace and does not run the official Kilo Code release workflow.

The Marketplace workflow is intentionally manual and requires a
`VSCE_PAT` GitHub Actions secret belonging to the `hainuo-wang` VS Code
Marketplace publisher. Run it with the release tag after reviewing the
generated runtime VSIX files and Extension Pack. The large offline Installer
VSIX is uploaded to GitHub Releases but is not published to the Marketplace.

## License

MIT. Kilo Remote Agent is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.

---

# Kilo Remote Agent（中文）

**面向 VS Code Remote SSH、网络受限 Linux 服务器、无互联网远程服务器和离线开发环境的 Cursor 风格本地大脑/远程执行 Agent。**

Kilo Remote Agent 解决这样一个实际问题：远程 Linux 服务器没有互联网，
不能访问大模型 API，但本机 Windows 或 Linux 可以访问模型服务。模型请求、
Agent 主循环、推理、工具选择、会话状态和 API Key 保留在本机；远程服务器
只负责操作工作区文件、执行命令、运行 Python、pytest、CUDA、Git 和 PTY。

简单说：

> **大脑在本机，双手在远程服务器。**

适用场景包括：

- 网络受限（network-restricted）的远程 Linux 服务器；
- 完全离线（offline）或没有互联网（no Internet）的服务器；
- 通过 VS Code Remote SSH 开发远程工作区；
- 公司办公网、堡垒机、relay、中转机或 MFA 保护的环境；
- 本机可以访问 OpenAI-compatible API、远程服务器不能访问模型 API；
- 希望使用本地 LLM Controller 驱动远程 coding agent；
- 需要在远程服务器执行文件操作、终端、Python、pytest、Git 或 CUDA；
- 不使用额外 SSH 连接、`ssh -R`、SOCKS 或全局 HTTP 代理的远程 Agent。

本项目是独立的开源项目，基于 Kilo Code 和 OpenCode 开发。它使用独立
的 VS Code 扩展 ID，不会被官方 Kilo Code 扩展覆盖升级，也不代表官方
Kilo Code 项目。

## 为什么需要这个项目

很多 AI 编程工具默认 Agent 和模型 API 在同一台机器上。但在公司内网、
堡垒机、relay、计算集群、GPU 服务器和无互联网服务器中，常见情况是：

```text
本机 Windows 工作站                       远程 Linux 服务器
可以访问大模型 API                         没有互联网或网络受限
保存 API Key                               不能接收 API Key
运行 Agent 主循环                          执行工作区工具
```

Kilo Remote Agent 将“模型和推理”和“工作区执行”拆成两个真正的执行端，
而不是让本地扩展猜测 Remote SSH 工作区实际应该使用哪台机器的 shell。
它不依赖 `vscode.window.createTerminal()` 捕获远程命令输出，也不会把完整
的 `kilo serve` 放到本机后直接操作远程 `/home/...` 路径。

## 目标架构

```text
Windows 或 Linux 本机
┌─────────────────────────────────────────┐
│ Kilo Remote Agent Controller             │
│                                         │
│ Agent 主循环与推理                       │
│ prompt/context 编排                      │
│ Provider 与模型 HTTP 请求                │
│ 对话/会话状态                            │
│ VS Code SecretStorage 中的 API Key       │
│ 本机 kilo serve                          │
└──────────────────┬──────────────────────┘
                   │
                   │ VS Code Remote SSH 命令通道
                   │ 不创建额外 SSH，也不使用 ssh -R
                   ▼
Linux 远程 SSH 工作区
┌─────────────────────────────────────────┐
│ Kilo Remote Agent + Remote Worker        │
│                                         │
│ 远程文件系统与工作区路径                 │
│ read/write/edit/list/glob/grep           │
│ shell 与进程执行                         │
│ PTY 与终端会话                           │
│ stdout/stderr 流式返回                   │
│ Python、pytest、CUDA 与 Git 命令         │
└─────────────────────────────────────────┘
```

三个扩展分别运行在正确的位置：

| 组件 | 扩展 ID | 运行位置 | 职责 |
| --- | --- | --- | --- |
| 主 Kilo Remote Agent | `hainuo-wang.kilo-remote-agent` | Remote SSH Workspace Extension Host | Kilo UI、工作区集成和现有 backend HTTP/SSE 客户端 |
| Local Controller | `hainuo-wang.kilo-remote-agent-controller` | 本机 UI Extension Host | Agent runtime、模型 Provider、本机 `kilo serve`、SecretStorage 和传输代理 |
| Remote Worker | `hainuo-wang.kilo-remote-agent-worker` | Remote SSH Workspace Extension Host | 文件系统、搜索、进程、PTY、Git 相关命令和输出流 |

普通本地工作区仍保持原来的 Kilo 行为。只有启用
`kilo-code.new.experimental.cursorLikeRemote` 后，Remote SSH 窗口才使用
本地 Controller/远程 Worker 架构。

## 数据流

Local Controller 和 Remote Worker 之间复用 VS Code 已经建立的 Remote SSH
扩展通信通道。项目不自己实现 SSH，不创建第二条 SSH 连接，不使用
`ssh -R`，不建立 SOCKS，也不给远程服务器配置全局 HTTP 代理。

一次 Agent 工具调用的数据流如下：

```text
用户需求
  ↓
本机 Controller 的 Agent 主循环
  ↓
本机 DuckCoding/OpenAI-compatible 模型请求
  ↓
工具选择：read_file、edit_file、grep、run_command……
  ↓
VS Code command RPC
  ↓
Linux Remote Worker
  ↓
远程文件系统、shell、PTY、Python、pytest、Git 或 CUDA
  ↓
RPC 响应以及 stdout/stderr 流
  ↓
本机 Controller 汇总结果并继续推理
```

PoC 有意保留 Kilo 现有的 HTTP/SSE backend。Remote SSH 模式下，远程主
扩展通过 VS Code command RPC 将 backend 的 HTTP/SSE 请求代理到本机
Controller；本机 backend 再通过版本化 RPC bridge 调用 Remote Worker。
这样可以尽量复用上游 Kilo/OpenCode 的 Agent 和 Provider，同时把工作区
执行移动到真正拥有远程文件和进程的 Linux 机器上。

## 安全边界

- 大模型 HTTP 请求只从本机 Controller 发出。
- API Key 保存在本机 VS Code `SecretStorage`。
- API Key 不写入 workspace、远程配置、远程环境或远程文件系统。
- API Key 不进入 Worker RPC 参数，也不进入 command-RPC HTTP 参数。
- Remote Worker 只接收工具请求和工具结果，不接收模型凭据。
- 远程进程不会继承本机 Controller 的凭据变量。
- 如果本机需要 HTTP 代理访问 DuckCoding，代理只作用于本机 Controller。
- 远程 Linux 服务器可以保持完全无互联网，仍然使用本机可访问的模型。
- 公司 QR、password、OTP、relay、堡垒机和 MFA 仍由 VS Code Remote SSH
  负责，不由本项目重新实现或绕过。

本项目不会绕过公司的身份认证、网络访问控制、堡垒机策略或安全要求。

## 安装

前提是 VS Code Remote SSH 本身已经可以正常连接。安装时要注意：
Controller 安装在本机，主扩展和 Worker 安装在 Remote SSH 远程扩展主机。

### 在线使用 VS Code 插件市场安装

在线环境推荐安装 **Kilo Remote Agent for Remote SSH** Extension Pack。
它会安装三个运行时扩展，同时保留本机/远程的正确运行位置：

```text
Marketplace Extension Pack
├── 本机 Controller
├── Remote SSH 主扩展
└── Remote SSH Worker
```

本机 VS Code 需要能够访问插件市场。VS Code 会通过已经建立的 Remote SSH
会话，根据每个组件声明的 UI/workspace 宿主位置完成安装；远程服务器不需要
访问模型 API。

### 离线或网络受限环境安装

如果远程服务器没有互联网，请从 GitHub Release 下载单文件安装器：

```text
kilo-remote-agent-installer-<version>.vsix
```

同一个文件需要安装两次：

1. 在本机 VS Code 窗口安装它，然后执行
   `Kilo Remote Agent: Install Components`，安装本机 Controller。
2. 在 Remote SSH 窗口把同一个文件上传到远程工作区，在该窗口安装它，
   再执行相同命令，安装远程主扩展和 Worker。

Installer VSIX 内含对应平台的组件 VSIX，不需要远程服务器访问插件市场。
它只是安装引导程序，实际运行时仍然是三个独立扩展。

### Windows 本机 + Linux 远程服务器

如果需要手动安装运行时组件，从 GitHub Release 下载以下 VSIX：

```text
kilo-remote-agent-controller-win32-x64.vsix
kilo-remote-agent-linux-x64.vsix
kilo-remote-agent-worker-linux-x64.vsix
```

1. 在本机 Windows VS Code 窗口安装 `kilo-remote-agent-controller-win32-x64.vsix`。
2. 使用 VS Code Remote SSH 连接 Linux 服务器。
3. 在 Remote SSH 窗口通过 `Install in SSH: <host>` 安装 `kilo-remote-agent-linux-x64.vsix`。
4. 在同一个 Remote SSH 窗口安装 `kilo-remote-agent-worker-linux-x64.vsix`。
5. 在 User settings 中启用实验架构。
6. 执行 `Developer: Reload Window`。

本项目不需要再安装 VS Code Marketplace 中的官方 Kilo Code。不要在同一
个窗口同时启用官方 Kilo Code 和本项目，因为双方可能注册相同或相近的
Kilo 命令。

### 使用 VS Code CLI 安装

Remote SSH 主机已经在 VS Code 中配置好后，也可以使用：

```powershell
code --install-extension .\kilo-remote-agent-controller-win32-x64.vsix --force
code --remote ssh-remote+YOUR_HOST --install-extension .\kilo-remote-agent-linux-x64.vsix --force
code --remote ssh-remote+YOUR_HOST --install-extension .\kilo-remote-agent-worker-linux-x64.vsix --force
```

将 `YOUR_HOST` 替换为 SSH config 中供 VS Code 使用的 `Host` 名称。该方式
仍然复用 VS Code Remote SSH，不会绕过 QR、password、OTP、MFA、relay
或堡垒机流程。

如果本机也是 Linux，则将 Controller 替换为
`kilo-remote-agent-controller-linux-x64.vsix`。

## 配置 DuckCoding

在本机 User settings 中启用本地 Controller 和远程 Worker：

```json
{
  "kilo-code.new.experimental.cursorLikeRemote": true,
  "kilo-code.new.experimental.duckcoding.baseURL": "https://api.duckcoding.ai/v1",
  "kilo-code.new.experimental.duckcoding.model": "gpt-5.6-sol",
  "kilo-code.new.experimental.duckcoding.api": "responses"
}
```

实际使用的 Provider/Model 是 `duckcoding/gpt-5.6-sol`。默认 endpoint
兼容 OpenAI API。优先使用 Responses API；只有 endpoint 提供兼容的 Chat
Completions 时才将 `api` 改为 `chat`。

在**本机**的 Command Palette 执行：

```text
Kilo: Configure Local DuckCoding API Key
```

Secret 名称是 `duckcoding.apiKey`。请在本机 VS Code 窗口输入密钥，不要在
Remote SSH 窗口输入。密钥只保存到本机 `SecretStorage`，并且只注入本机
`kilo serve` 进程。

不要把密钥写入 `settings.json`、workspace 文件、`.env`、远程环境变量或
shell 命令。

如果只有本机需要代理访问 DuckCoding，可在本机配置：

```json
{
  "kilo-code.remoteController.proxy": "http://127.0.0.1:7897"
}
```

该设置只影响本机 Controller，不是给远程服务器出网的代理，也不会通过
Worker RPC 传到远程。

## 测试与验收

先在 VS Code Command Palette 执行：

```text
Kilo: Run Remote Worker Smoke Test
```

然后让 Agent 执行一个完整闭环，例如：

```text
读取一个 Python 文件，做一个小的安全修改，运行 pytest，完整显示
stdout 和 stderr，最后执行 git diff。
```

应验证：

- 模型请求从本机 Windows 成功发出；
- `pwd` 显示 Linux 远程 workspace，而不是 Windows 路径；
- `uname -a`、`python --version`、`pytest` 和 `git diff` 在远程执行；
- 读取和写入确实作用于远程 Linux 文件；
- stdout 和 stderr 完整、持续地返回本机 Agent；
- 远程环境没有 DuckCoding Key：

  ```sh
  env | grep -i api
  ```

- 远程服务器仍然无法访问模型服务：

  ```sh
  curl --connect-timeout 5 https://api.duckcoding.ai
  ```

  在本来就无互联网或受限的服务器上，该命令应失败。

测试断线处理时，可以在远程命令运行期间断开并重新连接 Remote SSH。
正在执行的 Worker 操作应返回明确的远程断开错误，本机 Controller 不应
崩溃；重新连接后再次执行 Smoke Test，应建立新的 Worker。

## 当前 PoC 范围

第一版 PoC 重点验证“本地大脑、远程双手”的闭环：

- `read_file`；
- `write_file` 与 `edit_file`；
- 目录列表、`glob` 与 `grep`；
- 带远程进程生命周期管理的 `run_command`；
- 完整 stdout/stderr streaming；
- PTY 创建、输入、resize 和关闭；
- 取消、超时和 Remote SSH 断开处理。

因此 Agent 可以读取远程 Python 文件，在远程 Linux 修改文件，执行
pytest，接收完整测试结果，然后继续本机推理。专门的 Git tool、索引、
LSP、诊断、MCP placement 和更多依赖工作区位置的工具仍需要后续逐项
路由。目前通过远程进程执行的 `git diff` 已经会在远程主机运行。

## 如何方便跟进 Kilo 主分支

本项目从一开始就按便于上游同步的方式组织：

- 实验功能默认关闭；
- 主 Kilo 扩展不硬依赖两个 companion extensions；
- Agent loop、Provider、SDK schema 和 HTTP/SSE API 尽量保持上游形态；
- Remote protocol 集中在 `packages/kilo-remote-protocol/`；
- Local Controller 集中在 `packages/kilo-vscode-remote-controller/`；
- Remote Worker 集中在 `packages/kilo-vscode-remote-worker/`；
- Worker runtime 集中在 `packages/opencode/src/kilocode/remote-worker/`；
- 共享 OpenCode 文件只做小范围路由和注册改动，并按项目规则保留合并标记。

跟进 Kilo Code 更新时：

1. 将新的 Kilo Code `main` 合并或 rebase 到本项目；
2. 优先解决少量、明确标记的路由和注册冲突；
3. 尽量保留上游 Agent、Provider、SDK 和生成 API 的改动；
4. 运行 Remote Worker 测试、各扩展 typecheck 和 annotation check；
5. 重新构建对应平台的 CLI artifact 和 VSIX；
6. 在真实 VS Code Remote SSH 工作区重新执行 Smoke Test。

这样不需要维护一份大幅改造过的 Agent 核心，后续升级 Kilo 主分支
会更容易，也更适合将独立的 Remote SSH 能力持续维护或提交 upstream。

## 构建与发布

安装依赖：

```bash
bun install
```

运行时组件和分发包的构建目录是：

```text
packages/kilo-vscode
packages/kilo-vscode-remote-controller
packages/kilo-vscode-remote-worker
packages/kilo-vscode-remote-installer
packages/kilo-vscode-remote-pack
```

在对应的 OpenCode artifact 构建完成后打包，Controller 和 Worker 会带上
匹配平台的 Kilo CLI/runtime。开发时可以使用
`kilo-code.remoteController.cliPath` 和 `kilo-code.remoteWorker.cliPath`
指定外部的本机或远程 CLI。

向 `hainuo-wang/Kilo-Remote-Agent` 推送 `v*` 标签会触发 GitHub Actions，
构建并上传平台对应的 VSIX 到 GitHub Release。该流程不会发布到 VS Code
Marketplace，也不会触发官方 Kilo Code 的发布流程。

Marketplace 发布流程是手动触发的，需要在 GitHub Actions 中配置属于
`hainuo-wang` VS Code Marketplace publisher 的 `VSCE_PAT` Secret。审查
生成的运行时 VSIX 和 Extension Pack 后，再用对应 release tag 手动运行
该 workflow。体积较大的离线 Installer VSIX 只上传 GitHub Release，不发布
到 Marketplace。

## License

MIT。Kilo Remote Agent 基于 Kilo Code 和 OpenCode，保留原项目各自的
许可证和归属信息。
