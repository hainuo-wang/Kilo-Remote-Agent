const REDACTED: Buffer<ArrayBufferLike> = Buffer.from("[REDACTED]", "utf8")

export class StreamingSecretRedactor {
  private readonly patterns: Buffer<ArrayBufferLike>[]
  private readonly carrySize: number
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  constructor(values: Iterable<string>) {
    this.patterns = secretVariants(values)
      .map((value) => Buffer.from(value, "utf8") as Buffer<ArrayBufferLike>)
      .sort((left, right) => right.byteLength - left.byteLength)
    this.carrySize = Math.max(0, ...this.patterns.map((pattern) => pattern.byteLength - 1))
  }

  write(chunk: Uint8Array): Buffer<ArrayBufferLike> {
    if (this.patterns.length === 0) return Buffer.from(chunk)
    const input = Buffer.concat([this.pending, Buffer.from(chunk)])
    return this.process(input, Math.max(0, input.byteLength - this.carrySize))
  }

  end(): Buffer<ArrayBufferLike> {
    if (this.patterns.length === 0) return Buffer.alloc(0)
    return this.process(this.pending, this.pending.byteLength)
  }

  redactText(value: string): string {
    let output = value
    for (const pattern of this.patterns) {
      output = output.replaceAll(pattern.toString("utf8"), REDACTED.toString("utf8"))
    }
    return output
  }

  private process(input: Buffer<ArrayBufferLike>, emitLimit: number): Buffer<ArrayBufferLike> {
    const output: Buffer<ArrayBufferLike>[] = []
    let cursor = 0
    while (cursor < emitLimit) {
      const match = this.nextMatch(input, cursor)
      if (!match || match.index >= emitLimit) {
        output.push(input.subarray(cursor, emitLimit))
        cursor = emitLimit
        break
      }
      if (match.index > cursor) output.push(input.subarray(cursor, match.index))
      output.push(REDACTED)
      cursor = match.index + match.pattern.byteLength
    }
    this.pending = input.subarray(cursor)
    return Buffer.concat(output)
  }

  private nextMatch(
    input: Buffer<ArrayBufferLike>,
    offset: number,
  ): { index: number; pattern: Buffer<ArrayBufferLike> } | undefined {
    let result: { index: number; pattern: Buffer<ArrayBufferLike> } | undefined
    for (const pattern of this.patterns) {
      const index = input.indexOf(pattern, offset)
      if (index === -1) continue
      if (
        !result ||
        index < result.index ||
        (index === result.index && pattern.byteLength > result.pattern.byteLength)
      ) {
        result = { index, pattern }
      }
    }
    return result
  }
}

function secretVariants(values: Iterable<string>): string[] {
  const result = new Set<string>()
  for (const value of values) {
    if (!value) continue
    result.add(value)
    result.add(JSON.stringify(value).slice(1, -1))
    result.add(encodeURIComponent(value))
    result.add(Buffer.from(value, "utf8").toString("base64"))
  }
  result.delete("")
  return [...result]
}
