import { describe, expect, test } from "bun:test"
import { StreamingSseDirectoryRewriter } from "../src/sse-directory-rewriter"

const virtualDirectory = "C:\\Users\\user\\AppData\\Kilo\\remote-workspaces\\abc"
const remoteDirectory = "/home/user/project"

describe("streaming SSE directory rewriting", () => {
  test("rewrites an event split across arbitrary byte chunks", () => {
    const rewriter = new StreamingSseDirectoryRewriter(virtualDirectory, remoteDirectory)
    const input = Buffer.from(
      `data: ${JSON.stringify({
        directory: virtualDirectory,
        payload: { type: "session.created", properties: { directory: virtualDirectory } },
      })}\n\n`,
    )
    const chunks = [input.subarray(0, 7), input.subarray(7, 19), input.subarray(19)]
    const output = Buffer.concat(chunks.map((chunk) => rewriter.write(chunk)))
    const result: unknown = JSON.parse(output.toString("utf8").match(/^data: (.+)$/m)?.[1] ?? "{}")

    expect(result).toMatchObject({
      directory: remoteDirectory,
      payload: { properties: { directory: remoteDirectory } },
    })
    expect(output.toString("utf8")).toEndWith("\n\n")
  })

  test("preserves nonmatching events byte-for-byte", () => {
    const rewriter = new StreamingSseDirectoryRewriter(virtualDirectory, remoteDirectory)
    const input = Buffer.from('event: message\ndata: {"directory":"/other/project"}\n\n')

    expect(Buffer.concat([rewriter.write(input), rewriter.end()])).toEqual(input)
  })

  test("flushes an unterminated final event", () => {
    const rewriter = new StreamingSseDirectoryRewriter(virtualDirectory, remoteDirectory)
    const input = Buffer.from(`data: ${JSON.stringify({ directory: virtualDirectory })}`)

    expect(rewriter.write(input)).toHaveLength(0)
    const output = rewriter.end().toString("utf8")
    expect(output).toContain(`"directory":"${remoteDirectory}"`)
  })
})
