import { TerminalBookkeeping, type TerminalEntry } from "./terminal-bookkeeping"
import type { CursorRemotePty } from "../experimental/cursor-remote/pty-client"

type Entry = TerminalEntry & {
  streamId: string
  wsUrl: string
}

type Params = {
  terminalId: string
  worktreeId: string | null
  cwd: string
  title: string
  cols?: number
  rows?: number
}

export class RemoteTerminalManager {
  private readonly state = new TerminalBookkeeping<Entry>()
  private readonly restarts = new Map<string, Promise<void>>()

  constructor(
    private readonly pty: CursorRemotePty,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  async create(params: {
    terminalId: string
    worktreeId: string | null
    cwd: string
    title: string
    cols?: number
    rows?: number
  }): Promise<{ terminalId: string; worktreeId: string | null; title: string; wsUrl: string }> {
    return this.state.create(params, () => this.createImpl(params))
  }

  async blockDirectory(directory: string): Promise<() => void> {
    return this.state.blockDirectory(directory)
  }

  async closeDirectory(directory: string): Promise<void> {
    return this.state.closeDirectory(directory, (terminalId) => this.close(terminalId))
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    await this.state.resize(terminalId, { cols, rows }, (entry, size) =>
      this.pty.resize({ streamId: entry.streamId, ...size }),
    )
  }

  titles(worktreeId: string | null): string[] {
    return this.state.titles(worktreeId)
  }

  async close(terminalId: string): Promise<boolean> {
    this.state.pending.delete(terminalId)
    const entry = this.state.entries.get(terminalId)
    if (!entry) return true
    try {
      await this.pty.close({ streamId: entry.streamId })
      this.state.entries.delete(terminalId)
      this.log(`Remote terminal closed: ${terminalId} (stream ${entry.streamId})`)
      return true
    } catch (error) {
      this.log(`Remote terminal close failed (${terminalId}): ${message(error)}`)
      return false
    }
  }

  async restart(terminalId: string, cols?: number, rows?: number): Promise<string | undefined> {
    const entry = this.state.entries.get(terminalId)
    if (!entry) return
    const prior = this.restarts.get(terminalId)
    if (prior) {
      await prior
      return this.state.entries.get(terminalId)?.wsUrl
    }

    const task = this.restartEntry(entry, cols, rows)
    this.restarts.set(terminalId, task)
    await task.finally(() => {
      if (this.restarts.get(terminalId) === task) this.restarts.delete(terminalId)
    })
    const current = this.state.entries.get(terminalId)
    return current?.wsUrl
  }

  async dispose(): Promise<void> {
    this.state.clearPending()
    const entries = [...this.state.entries.values()]
    await Promise.all(entries.map((entry) => this.pty.close({ streamId: entry.streamId }).catch(() => undefined)))
    this.state.entries.clear()
  }

  private async createImpl(params: Params) {
    const initial = this.state.initialSize(params.terminalId, params.cols, params.rows)
    const created = await this.pty.create({ cwd: params.cwd, ...initial })
    const entry: Entry = {
      terminalId: params.terminalId,
      streamId: created.streamId,
      wsUrl: created.wsUrl,
      worktreeId: params.worktreeId,
      cwd: params.cwd,
      title: params.title,
    }
    this.state.entries.set(params.terminalId, entry)
    await this.state.applyLatestResize(params.terminalId, initial, (size) =>
      this.pty.resize({ streamId: entry.streamId, ...size }),
    )
    return {
      terminalId: entry.terminalId,
      worktreeId: entry.worktreeId,
      title: entry.title,
      wsUrl: created.wsUrl,
    }
  }

  private async restartEntry(entry: Entry, cols?: number, rows?: number): Promise<void> {
    const created = await this.pty.create({
      cwd: entry.cwd,
      cols,
      rows,
    })
    const old = entry.streamId
    entry.streamId = created.streamId
    entry.wsUrl = created.wsUrl
    await this.pty.close({ streamId: old }).catch((error) => {
      this.log(`Remote terminal old stream close failed (${entry.terminalId}): ${message(error)}`)
    })
    this.log(`Remote terminal restarted: ${entry.terminalId} (stream ${entry.streamId})`)
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
