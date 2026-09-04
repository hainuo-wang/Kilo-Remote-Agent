# Kilo Remote Agent Worker

## 中文文档

这是 Kilo Remote Agent 的远程 Worker，必须安装在 VS Code Remote SSH 的
Workspace Extension Host，而不是只安装在本机。

Worker 在远程 Linux 上执行文件读写、搜索、Shell、进程、PTY、Python、测试、
CUDA 和 Git 命令，并将 stdout/stderr 流式返回本机 Controller。它不接收模型
Provider 配置或 API Key。

Worker 仅在 Remote SSH 窗口且实验架构启用时工作，因此不会改变普通本地
workspace。开发时可以使用 `kilo-code.remoteWorker.cliPath` 指定远程 CLI。

## English Documentation

This package is the remote Worker for Kilo Remote Agent. Install it in the VS
Code Remote SSH workspace extension host, not only on the local machine.

The Worker executes filesystem operations, search, shell commands, processes,
PTY sessions, Python, tests, CUDA, and Git on the remote Linux host. stdout and
stderr stream back to the local Controller. The Worker never receives model
Provider configuration or API credentials.

It only operates in a Remote SSH window when the experimental architecture is
enabled, so ordinary local workspaces are unaffected. Set
`kilo-code.remoteWorker.cliPath` to use an external remote CLI during
development.

## License

MIT. This project is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.
