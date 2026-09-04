# Kilo Remote Agent Installer

This is the offline, single-file installer for Kilo Remote Agent. It bundles
the platform-specific Controller, Main Agent, and Remote Worker VSIX files so
that a network-restricted or offline Remote SSH environment does not need
Marketplace access.

Install this same VSIX in two contexts:

1. In a local VS Code window, run `Kilo Remote Agent: Install Components` to
   install the local Controller.
2. In a VS Code Remote SSH window, install this VSIX again and run the same
   command to install the remote Main Agent and Worker.

The installer does not run an Agent, start `kilo serve`, read API keys, or
create an SSH connection.
