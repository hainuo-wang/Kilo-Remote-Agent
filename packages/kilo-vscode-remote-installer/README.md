# Kilo Remote Agent Installer

## 中文文档

这是 Kilo Remote Agent 的离线单文件安装器，适用于远程服务器无互联网、
网络受限或无法访问 VS Code Marketplace 的环境。

同一个 Installer VSIX 使用两次：

1. 在本机 VS Code 窗口安装并执行 `Kilo Remote Agent: Install Components`，安装本机 Controller；
2. 在 Remote SSH 窗口安装同一个文件并执行相同命令，安装远程 Main Agent 和 Worker。

Installer 只负责安装引导，不启动 Agent、不读取 API Key、不创建额外 SSH
连接，也不处理 QR、password、OTP 或 MFA。

## English Documentation

This is the single-file offline installer for Kilo Remote Agent. It is intended
for Remote SSH servers that have no Internet access, restricted networking, or
no access to the VS Code Marketplace.

Install the same Installer VSIX twice: once in the local VS Code window and
once in the Remote SSH window. Run `Kilo Remote Agent: Install Components` in
each window to install the local Controller or the remote Main Agent and
Worker.

The installer does not run an Agent, read API keys, create another SSH
connection, or handle QR, password, OTP, or MFA authentication.

## License

MIT. This project is based on Kilo Code and OpenCode and retains their
respective licenses and attribution.
