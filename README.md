# Kilo Remote Agent

## 中文文档

Kilo Remote Agent 是一个面向 VS Code Remote SSH 的“本机大脑、远程双手”
开源 Coding Agent，适用于网络受限、无互联网、隔离网、堡垒机、Relay、MFA
保护的 Linux 远程服务器。

核心原则：

- Agent loop、推理、Provider、模型请求和会话状态运行在本机；
- API Key 只保存在本机 VS Code SecretStorage；
- 远程服务器不接收 API Key，也不需要访问模型 API；
- 文件读写、搜索、Shell、PTY、Python、pytest、CUDA、Git 和进程执行运行在远程 Linux；
- 复用 VS Code Remote SSH 已建立的通道，不重新实现 SSH；
- 不使用 `ssh -R`、SOCKS、全局 HTTP Proxy 或绕过公司认证/MFA；
- 普通本地开发模式保持可用，Remote SSH 架构通过实验开关启用。

### 目标架构

```text
本机 Windows / Linux
┌──────────────────────────────────────┐
│ Local Controller                     │
│ Agent loop · Provider · 模型请求       │
│ 会话状态 · 本机 SecretStorage          │
│ 本机 kilo serve                       │
└────────────────┬─────────────────────┘
                 │ VS Code Remote SSH 通道
                 ▼
远程 Linux Workspace
┌──────────────────────────────────────┐
│ Main Agent + Remote Worker            │
│ 文件系统 · grep · glob · 搜索           │
│ Shell · Process · PTY · stdout/stderr │
│ Python · pytest · CUDA · Git          │
└──────────────────────────────────────┘
```

运行时组件分开安装，以确保每个组件运行在正确的 Extension Host：

| 组件 | Extension ID | 运行位置 | 主要职责 |
| --- | --- | --- | --- |
| Main Agent | `hainuo-wang.kilo-remote-agent` | Remote SSH Workspace Host | Kilo UI、workspace 集成、HTTP/SSE 客户端 |
| Local Controller | `hainuo-wang.kilo-remote-agent-controller` | 本机 UI Extension Host | Agent runtime、Provider、本机 `kilo serve`、凭据和传输代理 |
| Remote Worker | `hainuo-wang.kilo-remote-agent-worker` | Remote SSH Workspace Host | 文件、搜索、进程、PTY、Git 命令和输出流 |

### 数据流与安全边界

模型请求路径：

```text
用户输入
  → 本机 Controller
  → 本机 Provider / LLM API
  → 本机 Agent 推理和 Tool selection
```

工具请求路径：

```text
本机 Agent
  → VS Code Remote SSH command transport
  → Remote Main Agent
  → Remote Worker
  → Linux 文件系统 / Shell / PTY / Git
  → stdout/stderr streaming 返回本机
```

远程 Worker 只接收工具请求和工具结果，不接收 Provider 配置或 API
凭据。Remote SSH 的 QR、password、OTP、Relay、堡垒机和 MFA 流程继续由
VS Code Remote SSH 管理，本项目不建立第二条 SSH 连接。

### 安装

前提：VS Code Remote SSH 已经可以正常连接目标 Linux 服务器。

#### 在线安装

在 VS Code Marketplace 安装 **Kilo Remote Agent for Remote SSH** Extension
Pack。它包含三个运行时扩展，VS Code 会按 `ui` / `workspace` 声明将它们
放入正确的本机或 Remote SSH Extension Host。

本机 VS Code 需要访问 Marketplace。远程服务器不需要访问模型 API。

#### 离线或网络受限环境安装

从 GitHub Release 下载单文件：

```text
kilo-remote-agent-installer-<version>.vsix
```

同一个文件安装两次：

1. 在普通本机 VS Code 窗口安装，执行 `Kilo Remote Agent: Install Components`，安装本机 Controller；
2. 连接 Remote SSH 后，在远程窗口安装同一个 VSIX，再执行相同命令，安装远程 Main Agent 和 Worker。

Installer VSIX 只负责安装引导，内含对应平台组件，不启动 Agent、不读取
API Key，也不创建额外 SSH 连接。

#### 手动安装运行时组件

Windows 本机 + Linux 远程服务器需要：

```text
kilo-remote-agent-controller-win32-x64.vsix
kilo-remote-agent-linux-x64.vsix
kilo-remote-agent-worker-linux-x64.vsix
```

Controller 安装在本机窗口；Main Agent 和 Worker 使用 Remote SSH 窗口的
“Install in SSH”安装。官方 Kilo Code 扩展不是该独立构建的运行依赖。

### 测试与验收

先在 Command Palette 执行：

```text
Kilo: Run Remote Worker Smoke Test
```

然后验证：

- Agent 可以读取和修改远程 Linux workspace 文件；
- `pwd`、`uname -a`、`python`、`pytest`、`git diff` 在远程 Linux 执行；
- stdout/stderr 可以完整、持续地返回本机 Agent；
- 远程 `env | grep -i api` 找不到本机模型 API Key；
- 远程服务器访问模型服务仍然失败；
- Remote SSH 断开时，Worker 失效并返回明确错误，本机 Agent 不崩溃；
- 重新连接后可以建立新的 Worker。

完整闭环示例：

```text
读取远程 Python 文件
  → 本机 Agent 推理
  → 远程修改文件
  → 远程执行 pytest
  → stdout/stderr 返回本机
  → 本机 Agent 根据结果继续处理
```

### 目录与上游同步

Remote SSH 相关代码尽量放在独立包中，避免维护大幅修改的 Agent 核心：

- `packages/kilo-vscode-remote-controller/`：本机 Controller；
- `packages/kilo-vscode-remote-worker/`：远程 Worker；
- `packages/kilo-vscode-remote-installer/`：离线单文件 Installer；
- `packages/kilo-vscode-remote-pack/`：Marketplace Extension Pack；
- `packages/kilo-remote-protocol/`：版本化 RPC 协议；
- `packages/opencode/src/kilocode/remote-worker/`：Worker runtime；
- `packages/kilo-vscode/`：Remote SSH 主扩展和现有 Kilo 集成。

跟进 Kilo Code 主分支时：

1. 合并或 rebase 上游 `main`；
2. 优先解决独立 Remote SSH 包和少量明确标记的路由冲突；
3. 保留上游 Agent、Provider、SDK 和生成 API 改动；
4. 运行相关 typecheck、单测、annotation check 和真实 Remote SSH Smoke Test；
5. 重新构建 CLI artifact 与平台 VSIX。

### 构建与发布

安装依赖：

```bash
bun install
```

相关包：

```text
packages/kilo-vscode
packages/kilo-vscode-remote-controller
packages/kilo-vscode-remote-worker
packages/kilo-vscode-remote-installer
packages/kilo-vscode-remote-pack
```

向 `main` 推送 `v*` 标签会触发 GitHub Release Workflow，构建并上传运行时
VSIX、单文件离线 Installer 和 Extension Pack。离线 Installer 只上传
GitHub Release，不发布到 Marketplace。

Marketplace 发布由 `.github/workflows/publish-kilo-remote-agent-marketplace.yml`
手动触发，需要仓库 Secret `VSCE_PAT`，且该 Token 属于 `hainuo-wang`
Marketplace Publisher。

## English Documentation

Kilo Remote Agent is an open-source “local brain, remote hands” coding agent
for VS Code Remote SSH, network-restricted Linux servers, offline workspaces,
air-gapped environments, bastion hosts, relays, and MFA-protected systems.

### Design

- The Agent loop, reasoning, Provider, model requests, and session state run locally.
- The API key stays in local VS Code SecretStorage.
- The remote server never receives the API key and does not need model API access.
- Filesystem, search, shell, PTY, Python, tests, CUDA, Git, and processes run remotely.
- The existing VS Code Remote SSH transport is reused; no second SSH connection is created.
- The design does not use `ssh -R`, SOCKS, a global HTTP proxy, or MFA bypasses.
- Normal local development remains supported; Remote SSH mode is opt-in.

### Runtime placement

```text
Local Windows / Linux
  Local Controller: Agent loop · Provider · model requests · SecretStorage
                   · local kilo serve
                              │ VS Code Remote SSH transport
                              ▼
Remote Linux Workspace
  Main Agent + Worker: filesystem · search · shell · PTY · processes
                       · Python · pytest · CUDA · Git · streamed output
```

The runtime extensions are intentionally separate:

- `hainuo-wang.kilo-remote-agent` runs in the Remote SSH workspace host;
- `hainuo-wang.kilo-remote-agent-controller` runs in the local UI host;
- `hainuo-wang.kilo-remote-agent-worker` runs in the Remote SSH workspace host.

The remote Worker receives tool requests and tool results, not model provider
credentials. VS Code Remote SSH continues to own QR, password, OTP, relay,
bastion, and MFA handling.

### Installation

The existing VS Code Remote SSH connection must already work.

For online installation, install **Kilo Remote Agent for Remote SSH** from the
VS Code Marketplace. The Extension Pack contains the three runtime extensions
and VS Code places them according to their declared extension hosts.

For offline or network-restricted servers, download:

```text
kilo-remote-agent-installer-<version>.vsix
```

Install the same file in the local window and in the Remote SSH window, then
run `Kilo Remote Agent: Install Components` in each window. The local run
installs the Controller; the Remote SSH run installs Main Agent and Worker.

Manual Windows-local/Linux-remote installation uses:

```text
kilo-remote-agent-controller-win32-x64.vsix
kilo-remote-agent-linux-x64.vsix
kilo-remote-agent-worker-linux-x64.vsix
```

### Verification

Run `Kilo: Run Remote Worker Smoke Test`, then verify that remote files are
read and written remotely, `pwd` and `uname -a` identify Linux, Python/tests/
Git run on the server, stdout/stderr stream completely, and credentials do
not appear in the remote environment. Disconnecting and reconnecting Remote
SSH must invalidate and recreate the Worker without crashing the local Agent.

### Upstream synchronization

Remote SSH code is isolated in companion packages and a versioned protocol so
upstream Kilo Code updates remain easier to merge. Keep upstream Agent,
Provider, SDK, and generated API changes whenever possible; resolve the small
Remote SSH routing hunks separately; then run type checks, tests, annotation
checks, packaging, and a real Remote SSH Smoke Test.

### Build and release

Run `bun install`, build the runtime artifacts, and package the five relevant
directories listed above. Pushing a `v*` tag creates a GitHub Release with the
runtime VSIX files, offline Installer, and Extension Pack. Marketplace
publishing is a separate manual workflow requiring the `VSCE_PAT` repository
secret for the `hainuo-wang` publisher.

## License

MIT. This project is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.
