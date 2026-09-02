import { describe, expect, test } from "bun:test"
import { RemoteTextDecoder } from "@/kilocode/remote-worker/text-decoder"

describe("remote text decoder", () => {
  test("preserves UTF-8 characters split across process events", () => {
    const decoder = new RemoteTextDecoder()
    const bytes = new TextEncoder().encode("远端输出")
    const pieces = [...bytes].map((value) => Uint8Array.of(value))

    const output = pieces.map((piece) => decoder.decode(piece)).join("") + decoder.end()

    expect(output).toBe("远端输出")
  })
})
