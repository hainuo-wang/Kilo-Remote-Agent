import { describe, expect, it } from "bun:test"
import { resolveInstallerSide, resolvePayloads } from "../src/install-plan"

describe("offline installer plan", () => {
  it("installs the local Controller when the installer runs in the UI host", () => {
    expect(resolveInstallerSide({ kind: "ui", remoteName: "ssh-remote+gpu" })).toBe("local")
    expect(resolvePayloads("local", { platform: "win32", arch: "x64" })).toEqual([
      "kilo-remote-agent-controller-win32-x64.vsix",
    ])
  })

  it("installs the Windows Controller in a local Windows window", () => {
    expect(resolveInstallerSide({ kind: "workspace" })).toBe("local")
    expect(resolvePayloads("local", { platform: "win32", arch: "x64" })).toEqual([
      "kilo-remote-agent-controller-win32-x64.vsix",
    ])
  })

  it("installs the Linux Controller in a local Linux window", () => {
    expect(resolvePayloads("local", { platform: "linux", arch: "x64" })).toEqual([
      "kilo-remote-agent-controller-linux-x64.vsix",
    ])
  })

  it("installs Main and Worker in a Linux Remote SSH window", () => {
    expect(resolveInstallerSide({ kind: "workspace", remoteName: "ssh-remote+gpu" })).toBe("remote-ssh")
    expect(resolvePayloads("remote-ssh", { platform: "linux", arch: "x64" })).toEqual([
      "kilo-remote-agent-linux-x64.vsix",
      "kilo-remote-agent-worker-linux-x64.vsix",
    ])
  })

  it("does not install SSH components in unsupported remote environments", () => {
    expect(resolveInstallerSide({ kind: "workspace", remoteName: "dev-container" })).toBe("unsupported-remote")
    expect(resolvePayloads("unsupported-remote", { platform: "linux", arch: "x64" })).toEqual([])
  })

  it("rejects unsupported platforms", () => {
    expect(resolvePayloads("local", { platform: "darwin", arch: "arm64" })).toEqual([])
    expect(resolvePayloads("remote-ssh", { platform: "linux", arch: "arm64" })).toEqual([])
  })
})
