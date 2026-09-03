# Kilo Remote Agent

Kilo Remote Agent 是一个面向 VS Code Remote SSH 的 Kilo Code 分支，实现类似 Cursor Remote SSH 的执行边界：

> Agent 的“脑子”在本机，文件、终端和进程的“手”在远程服务器。

本项目基于 [Kilo Code](https://github.com/Kilo-Org/kilocode) 开发，但使用独立扩展 ID，不会被官方 Kilo Code 扩展升级覆盖。

## 架构

```text
Windows / Linux Local
┌─────────────────────────────────────┐
│ Kilo Remote Agent Controller        │
│ Agent loop / LLM Provider           │
│ conversation and session state      │
│ API key / model HTTP requests       │
└──────────────────┬──────────────────┘
                   │ VS Code Remote RPC
                   ▼
Linux Remote SSH
┌─────────────────────────────────────┐
│ Kilo Remote Agent + Remote Worker   │
│ filesystem / edit / grep            │
│ process / PTY / stdout / stderr     │
│ git / Python / pytest / CUDA        │
└─────────────────────────────────────┘
```

通信复用 VS Code 已建立的 Remote SSH 通道，不创建额外 SSH 连接，不使用 `ssh -R`、SOCKS 或远程 HTTP 代理。

## 安全边界

- LLM 请求只从本机 Controller 发出。
- API Key 存放在本机 VS Code `SecretStorage`。
- API Key 不写入 workspace、配置文件或远程环境。
- Remote Worker 不接收 Provider 凭据。
- 远程服务器可以继续保持完全无互联网。
- 文件、Git、测试、Python、CUDA 和 PTY 命令均在远程 Linux 执行。

## 扩展组件

| 扩展 | ID | 安装位置 | 职责 |
|---|---|---|---|
| Kilo Remote Agent | `hainuo-wang.kilo-remote-agent` | Remote SSH Workspace Host | Kilo UI、远程工作区集成、Controller HTTP/SSE 客户端 |
| Controller | `hainuo-wang.kilo-remote-agent-controller` | Local UI Extension Host | Agent、Provider、SecretStorage、本机 `kilo serve` |
| Worker | `hainuo-wang.kilo-remote-agent-worker` | Remote SSH Workspace Host | 文件、搜索、进程、PTY、Git 和输出流 |

不需要再安装 VS Code Marketplace 中的官方 Kilo Code。由于两者仍共享部分 Kilo 命令名称，不建议同时启用官方扩展和 Kilo Remote Agent。

## 安装

从 GitHub Releases 下载与你环境匹配的 VSIX。典型的 Windows 本机 + Linux Remote SSH 环境需要：

```text
kilo-remote-agent-controller-win32-x64.vsix
kilo-remote-agent-linux-x64.vsix
kilo-remote-agent-worker-linux-x64.vsix
```

### 手动安装

1. 在本机 VS Code 中安装 Controller VSIX。
2. 连接 Remote SSH。
3. 在扩展页面使用 `Install in SSH: <host>`，安装 Agent 和 Worker 两个 Linux VSIX。
4. 在用户设置中启用：

```json
{
  "kilo-code.new.experimental.cursorLikeRemote": true,
  "kilo-code.new.experimental.duckcoding.baseURL": "https://api.duckcoding.ai/v1",
  "kilo-code.new.experimental.duckcoding.model": "gpt-5.6-sol",
  "kilo-code.new.experimental.duckcoding.api": "responses"
}
```

5. 执行 `Kilo: Configure Local DuckCoding API Key`。
6. 输入 API Key；它只保存到本机 SecretStorage。
7. 执行 `Developer: Reload Window`。

如果本机访问 DuckCoding 需要代理，可增加：

```json
{
  "kilo-code.remoteController.proxy": "http://127.0.0.1:7897"
}
```

该代理只注入本机 Controller，不会传给 Remote SSH 或 Remote Worker。

### 一次安装三个组件

已经连接过 Remote SSH 后，可以使用 VS Code CLI：

```powershell
code --install-extension .\kilo-remote-agent-controller-win32-x64.vsix --force
code --remote ssh-remote+YOUR_HOST --install-extension .\kilo-remote-agent-linux-x64.vsix --force
code --remote ssh-remote+YOUR_HOST --install-extension .\kilo-remote-agent-worker-linux-x64.vsix --force
```

`YOUR_HOST` 是 SSH config 中的 Host。该方式仍使用 VS Code Remote SSH，不会绕过 MFA、QR、密码或 OTP。

## 验证

先执行：

```text
Kilo: Run Remote Worker Smoke Test
```

再让 Agent 执行：

```text
运行 pwd、uname -a、python --version、git diff，并完整显示 stdout 和 stderr。
```

应满足：

- 命令运行在远程 Linux workspace。
- stdout 和 stderr 完整返回。
- 远程环境中没有 DuckCoding API Key。
- Remote SSH 断开时本机 Agent 不崩溃，重连后 Worker 可以恢复。

## 当前范围

PoC 已覆盖文件读取、写入、编辑、目录列表、glob、grep、命令执行、stdout/stderr streaming、PTY、取消、超时和 Remote SSH 断开处理。

索引、LSP、诊断、MCP placement 和更多工具仍需要逐项确认 Local/Remote 执行边界。

## 上游升级

Kilo Remote Agent 尽量不修改 Kilo/OpenCode 的核心 Agent 和 Provider：

- Remote 协议集中在 `packages/kilo-remote-protocol/`。
- Local Controller 位于 `packages/kilo-vscode-remote-controller/`。
- Remote Worker 位于 `packages/kilo-vscode-remote-worker/`。
- CLI Worker 位于 `packages/opencode/src/kilocode/remote-worker/`。
- 对共享 OpenCode 文件的修改保持最小，并保留项目现有的 `kilocode_change` 标记。

升级上游后运行：

```bash
bun turbo typecheck
cd packages/opencode && bun test ./test/kilocode/remote-worker.test.ts
cd ../kilo-vscode-remote-controller && bun test test
```

## 构建

```bash
bun install
```

本地开发可分别在以下目录运行 `bun run package`：

```text
packages/kilo-vscode
packages/kilo-vscode-remote-controller
packages/kilo-vscode-remote-worker
```

Controller 和 Worker VSIX 必须包含与目标平台匹配的 Kilo CLI。

正式版本由 GitHub Actions 在推送 `v*` 标签后构建。`v0.1.0` 会提供：

```text
kilo-remote-agent-linux-x64.vsix
kilo-remote-agent-controller-win32-x64.vsix
kilo-remote-agent-controller-linux-x64.vsix
kilo-remote-agent-worker-linux-x64.vsix
```

发布流程只创建 GitHub Release，不会向 VS Code Marketplace 发布，也不会调用上游 Kilo Code 的官方发布工作流。

## License

MIT。Kilo Remote Agent 基于 Kilo Code 和 OpenCode，保留原项目许可证与归属。
