import { describe, expect, test } from "bun:test"
import { StreamingSecretRedactor } from "../src/secret-redactor"

describe("StreamingSecretRedactor", () => {
  test("redacts raw, JSON escaped, URL encoded, and base64 secret variants", () => {
    const secret = 'team/"secret value'
    const redactor = new StreamingSecretRedactor([secret])
    const input = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ].join("|")
    const output = Buffer.concat([redactor.write(Buffer.from(input)), redactor.end()]).toString()

    expect(output).not.toContain(secret)
    expect(output).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(output).not.toContain(encodeURIComponent(secret))
    expect(output).not.toContain(Buffer.from(secret).toString("base64"))
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(4)
  })

  test("redacts a secret split across transport chunks", () => {
    const secret = "mioffice-team-key-123456"
    const redactor = new StreamingSecretRedactor([secret])
    const output = Buffer.concat([
      redactor.write(Buffer.from(`before:${secret.slice(0, 7)}`)),
      redactor.write(Buffer.from(secret.slice(7, 15))),
      redactor.write(Buffer.from(`${secret.slice(15)}:after`)),
      redactor.end(),
    ]).toString()

    expect(output).toBe("before:[REDACTED]:after")
    expect(output).not.toContain(secret)
  })

  test("passes bytes through when no secrets are configured", () => {
    const redactor = new StreamingSecretRedactor([])
    const chunk = Buffer.from([0, 1, 2, 255])
    expect(redactor.write(chunk)).toEqual(chunk)
    expect(redactor.end()).toHaveLength(0)
  })
})
