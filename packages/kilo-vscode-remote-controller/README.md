# Kilo Remote Agent Controller

## 中文文档

这是 Kilo Remote Agent 的本机 Controller，运行在本机 VS Code UI Extension
Host。它负责本机 Agent runtime、模型 Provider、会话状态、本机 `kilo serve`
以及与 Remote SSH Workspace Host 的传输代理。

Controller 只在本机读取和保存模型凭据。远程 Extension Host 只接收普通的
Agent 请求、工具结果和流式终端输出，不接收 API Key。

本项目保留现有 Kilo HTTP/SSE backend，并通过 VS Code command transport 将
Remote Main Agent 的请求转发给本机 Controller。远程 PTY 使用 Remote Worker
的进程实现，不能依赖 `vscode.window.createTerminal()` 捕获输出。

可用的开发测试命令：

```text
Kilo: Run Remote Worker Smoke Test
```

如果没有使用打包内置的 CLI，可通过 `kilo-code.remoteController.cliPath`
指定本机 CLI 路径。该设置只影响本机 Controller。

## English Documentation

This package is the local Controller for Kilo Remote Agent. It runs in the
local VS Code UI extension host and owns the local Agent runtime, model
Provider, session state, local `kilo serve`, and transport proxy to the Remote
SSH workspace host.

The Controller reads and stores model credentials only on the local machine.
The remote extension host receives ordinary Agent requests, tool results, and
streamed terminal output, never the API key.

The prototype preserves Kilo’s existing HTTP/SSE backend and forwards Remote
Main Agent requests through VS Code command transport. Remote PTY output comes
from the Remote Worker process implementation rather than
`vscode.window.createTerminal()` capture.

Use `Kilo: Run Remote Worker Smoke Test` for development verification. If the
bundled CLI is not suitable, set `kilo-code.remoteController.cliPath` to a
local CLI path; the setting affects only the local Controller.

## License

MIT. This project is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.
