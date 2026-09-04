# Kilo Remote Agent for Remote SSH

Install the Kilo Remote Agent components together for VS Code Remote SSH.

This Extension Pack is the Marketplace installation path. It installs the
three runtime extensions separately so VS Code can place the local Controller
in the local UI extension host and the Main Agent plus Remote Worker in the
Remote SSH workspace extension host.

The model provider, API key, Agent loop, and session state stay on the local
machine. Filesystem access, Git, commands, tests, and PTY processes run on the
Remote SSH Linux host. The remote server does not need access to the model API.

For offline or network-restricted servers, use the single-file Installer VSIX
from the GitHub Release instead. The Installer VSIX bundles the component
packages and does not require Marketplace access from the remote server.
