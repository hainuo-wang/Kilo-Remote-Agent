import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repo = join(import.meta.dir, "../../../..")

function manifest(packageName: string) {
  return JSON.parse(readFileSync(join(repo, packageName, "package.json"), "utf8")) as {
    version?: string
    extensionKind?: string[]
    api?: string
    activationEvents?: string[]
    extensionDependencies?: string[]
    contributes?: {
      configuration?: {
        properties?: Record<string, { default?: unknown; scope?: string }>
      }
    }
  }
}

describe("Cursor-like Remote SSH extension placement", () => {
  test("places the main extension in the workspace host when remote exists", () => {
    expect(manifest("packages/kilo-vscode").extensionKind).toEqual(["workspace"])
  })

  test("places the controller locally and the worker remotely", () => {
    const main = manifest("packages/kilo-vscode")
    const controller = manifest("packages/kilo-vscode-remote-controller")
    const worker = manifest("packages/kilo-vscode-remote-worker")
    expect(controller).toMatchObject({
      api: "none",
      extensionKind: ["ui"],
    })
    expect(worker).toMatchObject({
      api: "none",
      extensionKind: ["workspace"],
    })
    expect(controller.version).toBe(main.version)
    expect(worker.version).toBe(main.version)
  })

  test("keeps the experiment opt-in and does not force companion installation", () => {
    const main = manifest("packages/kilo-vscode")
    expect(main.contributes?.configuration?.properties?.["kilo-code.new.experimental.cursorLikeRemote"]).toMatchObject({
      default: false,
      scope: "application",
    })
    expect(main.extensionDependencies ?? []).not.toContain("kilocode.kilo-code-remote-controller")
    expect(main.extensionDependencies ?? []).not.toContain("kilocode.kilo-code-remote-worker")
  })

  test("activates both companions after the remote window is ready", () => {
    expect(manifest("packages/kilo-vscode-remote-controller").activationEvents).toContain("onStartupFinished")
    expect(manifest("packages/kilo-vscode-remote-worker").activationEvents).toContain("onStartupFinished")
  })
})
