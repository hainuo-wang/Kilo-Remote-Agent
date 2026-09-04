# Kilo Remote Agent for Remote SSH

## 中文文档

这是 Kilo Remote Agent 的 VS Code Marketplace Extension Pack，用于一次性
安装本机 Controller、Remote SSH Main Agent 和 Remote Worker。

本机负责 Agent loop、Provider、模型请求、会话状态和凭据；远程 Linux 负责
文件系统、Shell、PTY、Python、测试、CUDA、Git 和进程执行。远程服务器不需要
访问模型 API。

对于无互联网或网络受限服务器，请使用 GitHub Release 中的单文件 Installer
VSIX，而不是依赖 Marketplace 在远程端分发组件。

## English Documentation

This VS Code Marketplace Extension Pack installs the local Controller, Remote
SSH Main Agent, and Remote Worker together.

The local machine owns the Agent loop, Provider, model requests, session state,
and credentials. The remote Linux host owns filesystem, shell, PTY, Python,
tests, CUDA, Git, and process execution. The remote server does not need model
API access.

For offline or network-restricted servers, use the single-file Installer VSIX
from a GitHub Release instead of relying on Marketplace distribution on the
remote side.

## License

MIT. This project is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.
