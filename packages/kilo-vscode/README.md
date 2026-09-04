# Kilo Remote Agent

## 中文文档

Kilo Remote Agent 是面向 VS Code Remote SSH 的“本机大脑、远程双手”
Coding Agent。它适用于网络受限、无互联网或不能访问模型服务的 Linux
远程服务器。

本机 Controller 负责 Agent loop、模型请求、会话状态和本机凭据；该扩展
运行在 Remote SSH Workspace Host，负责 Kilo UI、workspace 集成和远程工具
路由。文件系统、Shell、PTY、进程、Python、测试、CUDA 和 Git 在远程服务器
执行，输出通过 VS Code Remote SSH 通道返回本机。

## 安装

在线安装 **Kilo Remote Agent for Remote SSH** Extension Pack。离线环境从
GitHub Release 下载单文件 Installer VSIX，在本机窗口和 Remote SSH 窗口各
安装一次，并执行 `Kilo Remote Agent: Install Components`。

官方 Kilo Code 扩展不是该独立构建的运行依赖。Remote SSH 的认证、Relay、
堡垒机和 MFA 流程仍由 VS Code Remote SSH 管理。

## 架构

```text
本机 Controller
  Agent loop · Provider · 模型请求 · SecretStorage · kilo serve
                         │ VS Code Remote SSH command transport
                         ▼
远程 Main Agent + Worker
  文件系统 · 搜索 · Shell · PTY · Process · Python · pytest · Git · CUDA
```

远程服务器不会接收本机 API Key，也不需要访问模型服务。本项目不创建第二条
SSH 连接，不使用 `ssh -R`、SOCKS 或全局 HTTP Proxy。

## 测试

在 Command Palette 执行：

```text
Kilo: Run Remote Worker Smoke Test
```

然后确认远程文件读写、远程命令执行、完整 stdout/stderr streaming 以及
Remote SSH 断线重连行为。

## English Documentation

Kilo Remote Agent is a “local brain, remote hands” coding agent for VS Code
Remote SSH, network-restricted Linux servers, and workspaces that cannot reach
the model provider.

The local Controller owns the Agent loop, model requests, session state, and
local credentials. This extension runs in the Remote SSH workspace host and
provides the Kilo UI, workspace integration, and remote tool routing.
Filesystem, shell, PTY, processes, Python, tests, CUDA, Git, and streamed
command output stay on the remote Linux server.

## Installation

Install **Kilo Remote Agent for Remote SSH** from the VS Code Marketplace, or
use the single-file Installer VSIX from a GitHub Release for offline servers.
Install the Installer once in the local window and once in the Remote SSH
window, then run `Kilo Remote Agent: Install Components` in each window.

The official Kilo Code extension is not required. VS Code Remote SSH continues
to own the existing authentication, relay, bastion, and MFA flow.

## Architecture

```text
Local Controller
  Agent loop · Provider · model requests · SecretStorage · local kilo serve
                              │ VS Code Remote SSH command transport
                              ▼
Remote Main Agent + Worker
  filesystem · search · shell · PTY · processes · Python · pytest · Git · CUDA
```

The remote server never receives the local API key and does not need model API
access. No second SSH connection, `ssh -R`, SOCKS proxy, or global HTTP proxy
is created.

## Verification

Run `Kilo: Run Remote Worker Smoke Test` and verify remote file operations,
remote command execution, complete stdout/stderr streaming, and Worker recovery
after a Remote SSH disconnect and reconnect.

## License

MIT. This project is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.
