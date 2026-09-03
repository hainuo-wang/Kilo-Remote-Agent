import path from "node:path"
import { block } from "./pty-cleanup"

export type TerminalSize = {
  cols: number
  rows: number
}

export type TerminalEntry = {
  terminalId: string
  worktreeId: string | null
  cwd: string
  title: string
}

export type TerminalCreateParams = {
  terminalId: string
  cwd: string
  cols?: number
  rows?: number
}

export class TerminalBookkeeping<Entry extends TerminalEntry> {
  readonly entries = new Map<string, Entry>()
  readonly pending = new Map<string, TerminalSize>()
  private readonly creates = new Map<string, Set<Promise<unknown>>>()
  private readonly blocked = new Map<string, number>()

  async create<T>(params: TerminalCreateParams, taskFactory: () => Promise<T>): Promise<T> {
    const directory = key(params.cwd)
    if (this.blocked.has(directory)) throw new Error(`PTY directory is being removed: ${params.cwd}`)
    const task = taskFactory()
    const creates = this.creates.get(directory) ?? new Set<Promise<unknown>>()
    if (!this.creates.has(directory)) this.creates.set(directory, creates)
    creates.add(task)
    try {
      return await task
    } finally {
      creates.delete(task)
      if (creates.size === 0) this.creates.delete(directory)
    }
  }

  async blockDirectory(directory: string): Promise<() => void> {
    const target = key(directory)
    return block(target, this.blocked, this.creates.get(target))
  }

  async closeDirectory(directory: string, close: (terminalId: string) => Promise<boolean>): Promise<void> {
    const target = key(directory)
    const entries = [...this.entries.values()].filter((entry) => key(entry.cwd) === target)
    const results = await Promise.all(entries.map((entry) => close(entry.terminalId)))
    if (results.some((result) => !result)) throw new Error(`Failed to close terminals in ${directory}`)
  }

  resize(
    terminalId: string,
    size: TerminalSize,
    apply: (entry: Entry, size: TerminalSize) => Promise<void>,
  ): Promise<void> {
    const entry = this.entries.get(terminalId)
    if (!entry) {
      this.pending.set(terminalId, size)
      return Promise.resolve()
    }
    this.pending.delete(terminalId)
    return apply(entry, size)
  }

  titles(worktreeId: string | null): string[] {
    return [...this.entries.values()].filter((entry) => entry.worktreeId === worktreeId).map((entry) => entry.title)
  }

  initialSize(terminalId: string, cols?: number, rows?: number): TerminalSize | undefined {
    const initial =
      this.pending.get(terminalId) ?? (cols !== undefined && rows !== undefined ? { cols, rows } : undefined)
    this.pending.delete(terminalId)
    return initial
  }

  async applyLatestResize(
    terminalId: string,
    initial: TerminalSize | undefined,
    apply: (size: TerminalSize) => Promise<void>,
  ): Promise<void> {
    const latest = this.pending.get(terminalId)
    if (!latest || (latest.cols === initial?.cols && latest.rows === initial?.rows)) return
    this.pending.delete(terminalId)
    await apply(latest)
  }

  clearPending() {
    this.pending.clear()
  }
}

function key(directory: string) {
  const value = path.resolve(directory)
  return process.platform === "win32" ? value.toLowerCase() : value
}
