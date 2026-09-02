import { describe, expect, test } from "bun:test"
import { rewriteWorkspaceDirectory, virtualWorkspaceDirectory } from "../src/workspace-routing"

describe("remote workspace routing", () => {
  test("rewrites directory query values without double encoding", () => {
    const url = new URL(
      "http://kilo-controller.invalid/api/session?directory=%2Fhome%2Fuser%2Fproject&location%5Bdirectory%5D=%2Fhome%2Fuser%2Fproject",
    )
    rewriteWorkspaceDirectory(url, "C:\\Users\\user\\AppData\\Kilo\\remote-workspaces\\abc")

    expect(url.searchParams.get("directory")).toBe("C:\\Users\\user\\AppData\\Kilo\\remote-workspaces\\abc")
    expect(url.searchParams.get("location[directory]")).toBe("C:\\Users\\user\\AppData\\Kilo\\remote-workspaces\\abc")
    expect(url.href).not.toContain("%252F")
  })

  test("keeps separate remote workspace identities isolated", () => {
    const root = "/tmp/kilo-controller-test-storage"
    const first = virtualWorkspaceDirectory(root, "ssh-remote", "host-a", "/home/user/project")
    const second = virtualWorkspaceDirectory(root, "ssh-remote", "host-b", "/home/user/project")
    const third = virtualWorkspaceDirectory(root, "ssh-remote", "host-a", "/home/user/other")

    expect(first).not.toBe(second)
    expect(first).not.toBe(third)
  })
})
