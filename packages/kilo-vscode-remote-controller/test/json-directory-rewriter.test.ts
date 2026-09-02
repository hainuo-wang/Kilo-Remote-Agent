import { describe, expect, test } from "bun:test"
import { rewriteJsonDirectories } from "../src/json-directory-rewriter"

const virtualDirectory = "C:\\Users\\user\\AppData\\Kilo\\remote-workspaces\\abc"
const remoteDirectory = "/home/user/project"

describe("JSON directory rewriting", () => {
  test("rewrites known path fields at any nesting level", () => {
    const input = {
      directory: virtualDirectory,
      session: { worktree: virtualDirectory, cwd: virtualDirectory },
      items: [{ currentDirectory: virtualDirectory }],
      message: virtualDirectory,
      path: virtualDirectory,
    }

    const output: unknown = JSON.parse(
      rewriteJsonDirectories(Buffer.from(JSON.stringify(input)), virtualDirectory, remoteDirectory).toString("utf8"),
    )

    expect(output).toMatchObject({
      directory: remoteDirectory,
      session: { worktree: remoteDirectory, cwd: remoteDirectory },
      items: [{ currentDirectory: remoteDirectory }],
      message: virtualDirectory,
      path: virtualDirectory,
    })
  })

  test("preserves invalid and unchanged JSON bytes", () => {
    const invalid = Buffer.from("{not-json")
    const unchanged = Buffer.from(JSON.stringify({ path: virtualDirectory }))

    expect(rewriteJsonDirectories(invalid, virtualDirectory, remoteDirectory)).toEqual(invalid)
    expect(rewriteJsonDirectories(unchanged, virtualDirectory, remoteDirectory)).toEqual(unchanged)
  })
})
