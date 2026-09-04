import * as vscode from "vscode"
import path from "node:path"
import { resolveInstallerSide, resolvePayloads } from "./install-plan"

const INSTALL_COMMAND = "kilo-remote-agent-installer.install"
const VSIX_INSTALL_COMMAND = "workbench.extensions.installExtension"

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand(INSTALL_COMMAND, () => installComponents(context)))
}

async function installComponents(context: vscode.ExtensionContext) {
  const extension = vscode.extensions.getExtension(context.extension.id)
  const kind =
    extension?.extensionKind === vscode.ExtensionKind.UI
      ? "ui"
      : extension?.extensionKind === vscode.ExtensionKind.Workspace
        ? "workspace"
        : "unknown"
  const side = resolveInstallerSide({
    kind,
    remoteName: vscode.env.remoteName,
  })
  const payloads = resolvePayloads(side, {
    platform: process.platform,
    arch: process.arch,
  })

  if (side === "unsupported-remote") {
    await vscode.window.showErrorMessage(
      `Kilo Remote Agent Installer supports local windows and VS Code Remote SSH only (remoteName=${vscode.env.remoteName ?? "none"}).`,
    )
    return
  }

  if (payloads.length === 0) {
    await vscode.window.showErrorMessage(
      `Kilo Remote Agent Installer does not include packages for ${side} ${process.platform}-${process.arch}.`,
    )
    return
  }

  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes(VSIX_INSTALL_COMMAND)) {
    await vscode.window.showErrorMessage(
      "This VS Code build does not expose the VSIX installation command required by the offline installer.",
    )
    return
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Kilo Remote Agent",
        cancellable: false,
      },
      async (progress) => {
        for (let index = 0; index < payloads.length; index++) {
          const payload = payloads[index]
          if (!payload) throw new Error(`Missing installer payload at index ${index}`)
          progress.report({
            message: `Installing ${payload} (${index + 1}/${payloads.length})`,
            increment: 100 / payloads.length,
          })
          const uri = vscode.Uri.file(path.join(context.extensionPath, "payload", payload))
          await vscode.commands.executeCommand(VSIX_INSTALL_COMMAND, uri)
        }
      },
    )
    const location = side === "remote-ssh" ? "Remote SSH host" : "local machine"
    await vscode.window.showInformationMessage(
      `Kilo Remote Agent components installed for the ${location}. Reload the VS Code window to activate them.`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await vscode.window.showErrorMessage(`Kilo Remote Agent component installation failed: ${message}`)
  }
}
