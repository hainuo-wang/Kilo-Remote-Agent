export type InstallerSide = "local" | "remote-ssh" | "unsupported-remote"

export type InstallerPlatform = {
  platform: string
  arch: string
}

export type InstallerPayload =
  | "kilo-remote-agent-controller-win32-x64.vsix"
  | "kilo-remote-agent-controller-linux-x64.vsix"
  | "kilo-remote-agent-controller-darwin-x64.vsix"
  | "kilo-remote-agent-controller-darwin-arm64.vsix"
  | "kilo-remote-agent-linux-x64.vsix"
  | "kilo-remote-agent-worker-linux-x64.vsix"

export function resolveInstallerSide(input: {
  kind: "ui" | "workspace" | "unknown"
  remoteName?: string
}): InstallerSide {
  if (input.kind === "ui") return "local"
  if (input.kind !== "workspace") return "unsupported-remote"
  if (!input.remoteName) return "local"
  if (input.remoteName.startsWith("ssh-remote")) return "remote-ssh"
  return "unsupported-remote"
}

export function resolvePayloads(side: InstallerSide, platform: InstallerPlatform): InstallerPayload[] {
  if (side === "local") {
    if (platform.platform === "win32" && platform.arch === "x64") {
      return ["kilo-remote-agent-controller-win32-x64.vsix"]
    }
    if (platform.platform === "linux" && platform.arch === "x64") {
      return ["kilo-remote-agent-controller-linux-x64.vsix"]
    }
    if (platform.platform === "darwin" && platform.arch === "x64") {
      return ["kilo-remote-agent-controller-darwin-x64.vsix"]
    }
    if (platform.platform === "darwin" && platform.arch === "arm64") {
      return ["kilo-remote-agent-controller-darwin-arm64.vsix"]
    }
    return []
  }

  if (side === "remote-ssh" && platform.platform === "linux" && platform.arch === "x64") {
    return ["kilo-remote-agent-linux-x64.vsix", "kilo-remote-agent-worker-linux-x64.vsix"]
  }

  return []
}
