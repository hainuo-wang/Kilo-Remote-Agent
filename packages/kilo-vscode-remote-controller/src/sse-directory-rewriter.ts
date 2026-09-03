import { rewriteJsonValue } from "./json-directory-rewriter"

type JsonValueRewriter = (value: unknown) => { value: unknown; changed: boolean }

export class StreamingSseDirectoryRewriter {
  private pending = Buffer.alloc(0)

  constructor(
    private readonly virtualDirectory?: string,
    private readonly remoteDirectory?: string,
    private readonly valueRewriter?: JsonValueRewriter,
  ) {}

  write(chunk: Uint8Array): Buffer {
    if (chunk.byteLength > 0) {
      this.pending = Buffer.concat([this.pending, Buffer.from(chunk)])
    }

    const output: Buffer[] = []
    while (true) {
      const boundary = findEventBoundary(this.pending)
      if (!boundary) break
      const frame = this.pending.subarray(0, boundary.end)
      this.pending = this.pending.subarray(boundary.end)
      output.push(this.rewriteFrame(frame))
    }
    return Buffer.concat(output)
  }

  end(): Buffer {
    if (this.pending.byteLength === 0) return Buffer.alloc(0)
    const frame = this.pending
    this.pending = Buffer.alloc(0)
    return this.rewriteFrame(frame)
  }

  private rewriteFrame(frame: Buffer): Buffer {
    const text = frame.toString("utf8")
    const boundary = eventBoundaryText(text)
    const content = boundary ? text.slice(0, -boundary.length) : text
    const lines = content.split(/\r\n|\n|\r/)
    const dataLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("data:"))

    if (dataLines.length === 0) return frame

    const data = dataLines.map(({ line }) => line.slice(5).replace(/^ /, "")).join("\n")
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return frame
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return frame
    const directoryRewrite =
      this.virtualDirectory !== undefined && this.remoteDirectory !== undefined
        ? rewriteJsonValue(parsed, this.virtualDirectory, this.remoteDirectory)
        : { value: parsed, changed: false }
    const valueRewrite = this.valueRewriter?.(directoryRewrite.value) ?? {
      value: directoryRewrite.value,
      changed: false,
    }
    if (!directoryRewrite.changed && !valueRewrite.changed) return frame

    const firstDataLine = dataLines[0]
    if (!firstDataLine) return frame
    const replacement = JSON.stringify(valueRewrite.value)
    if (dataLines.length === 1) {
      const line = lines[firstDataLine.index]
      if (line === undefined) return frame
      lines[firstDataLine.index] = `${line.slice(0, 5)} ${replacement}`
      return Buffer.from(`${lines.join(lineEnding(content))}${boundary}`, "utf8")
    }

    const dataLineIndexes = new Set(dataLines.map(({ index }) => index))
    const rewrittenLines = lines.filter((_, index) => !dataLineIndexes.has(index) || index === firstDataLine.index)
    const rewrittenIndex = lines.slice(0, firstDataLine.index).filter((_, index) => !dataLineIndexes.has(index)).length
    if (rewrittenLines[rewrittenIndex] === undefined) return frame
    rewrittenLines[rewrittenIndex] = `data: ${replacement}`
    return Buffer.from(`${rewrittenLines.join(lineEnding(content))}${boundary}`, "utf8")
  }
}

function findEventBoundary(buffer: Buffer): { end: number } | undefined {
  const candidates = [
    findSequence(buffer, Buffer.from("\n\n")),
    findSequence(buffer, Buffer.from("\r\r")),
    findSequence(buffer, Buffer.from("\r\n\r\n")),
  ].filter((index): index is number => index >= 0)
  if (candidates.length === 0) return undefined

  const index = Math.min(...candidates)
  const length = buffer[index] === 13 && buffer[index + 1] === 10 ? 4 : 2
  return { end: index + length }
}

function findSequence(buffer: Buffer, sequence: Buffer): number {
  return buffer.indexOf(sequence)
}

function eventBoundaryText(text: string): string | undefined {
  if (text.endsWith("\r\n\r\n")) return "\r\n\r\n"
  if (text.endsWith("\n\n")) return "\n\n"
  if (text.endsWith("\r\r")) return "\r\r"
  return undefined
}

function lineEnding(text: string): string {
  const match = text.match(/\r\n|\n|\r/)
  return match?.[0] ?? "\n"
}
