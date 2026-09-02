import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import * as vscode from "vscode"
import type { RpcCancel, RpcEvent, RpcMessage, RpcRequest, RpcResponse } from "@kilocode/kilo-remote-protocol"
import { isControllerCredentialEnvironmentKey, isRpcMessage, RPC_VERSION } from "@kilocode/kilo-remote-protocol"

type WorkerMessageHandler = (message: RpcEvent) => Promise<void>

export class WorkerProcess implements vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined
  private epoch = `remote-${crypto.randomUUID()}`
  private readonly disposables: vscode.Disposable[] = []
  private readonly pending = new Map<
    string,
    { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >()
  private readonly onMessage: WorkerMessageHandler
  private readonly onDisconnect: (error: Error) => void
  private writeQueue = Promise.resolve()
  private started = false

  constructor(
    private readonly cliPath: string,
    private readonly root: string,
    onMessage: WorkerMessageHandler,
    onDisconnect: (error: Error) => void,
  ) {
    this.onMessage = onMessage
    this.onDisconnect = onDisconnect
  }

  get workerEpoch() {
    return this.epoch
  }

  async request(request: RpcRequest): Promise<RpcResponse> {
    this.start()
    return new Promise((resolve, reject) => {
      const timer =
        request.deadline === undefined
          ? undefined
          : setTimeout(
              () => {
                const pending = this.pending.get(request.requestId)
                if (!pending) return
                this.pending.delete(request.requestId)
                pending.reject(new Error(`Remote worker request timed out: ${request.method}`))
                void this.write({
                  type: "cancel",
                  version: RPC_VERSION,
                  requestId: request.requestId,
                }).catch(() => undefined)
              },
              Math.max(0, request.deadline - Date.now()),
            )
      this.pending.set(request.requestId, { resolve, reject, timer })
      this.write({
        ...request,
        version: RPC_VERSION,
      }).catch((error) => {
        const pending = this.pending.get(request.requestId)
        if (pending?.timer) clearTimeout(pending.timer)
        this.pending.delete(request.requestId)
        reject(error)
      })
    })
  }

  cancel(requestId: string, streamId?: string): void {
    const message: RpcCancel = {
      type: "cancel",
      version: RPC_VERSION,
      requestId,
      ...(streamId ? { streamId } : {}),
    }
    void this.write(message).catch(() => undefined)
  }

  dispose(): void {
    const process = this.process
    this.process = undefined
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error("Remote worker disposed"))
    }
    this.pending.clear()
    if (process && !process.killed) process.kill()
  }

  private start() {
    if (this.started) return
    this.started = true
    this.epoch = `remote-${crypto.randomUUID()}`
    const child = spawn(this.cliPath, ["remote-worker", "--stdio", "--root", this.root], {
      cwd: this.root,
      env: remoteWorkerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.process = child
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.disposables.push({
      dispose: () => reader.close(),
    })
    void this.read(reader)
    child.stderr.on("data", (chunk) => {
      console.warn(`[Kilo Remote Worker] ${String(chunk).trimEnd()}`)
    })
    child.once("error", (error) => {
      if (this.process === child) this.disconnect(error, child)
    })
    child.once("close", (code, signal) => {
      if (this.process === child) {
        this.disconnect(new Error(`Remote worker exited (${code ?? "null"}, ${signal ?? "no signal"})`), child)
      }
    })
  }

  private async read(reader: ReturnType<typeof createInterface>) {
    try {
      for await (const line of reader) {
        if (!line.trim()) continue
        const message: unknown = JSON.parse(line)
        if (!isRpcMessage(message)) throw new Error("Remote worker returned an invalid RPC message")
        if (message.type === "response") {
          const pending = this.pending.get(message.requestId)
          if (pending) {
            this.pending.delete(message.requestId)
            if (pending.timer) clearTimeout(pending.timer)
            pending.resolve(message)
          }
        } else if (message.type === "event") {
          await this.onMessage(message)
        }
      }
    } catch (error) {
      this.disconnect(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private write(message: RpcMessage): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const process = this.process
            if (!process || process.stdin.destroyed) {
              reject(new Error("Remote worker is not running"))
              return
            }
            const line = JSON.stringify(message) + "\n"
            if (process.stdin.write(line, "utf8")) {
              resolve()
              return
            }
            process.stdin.once("drain", resolve)
            process.stdin.once("error", reject)
          }),
      )
    return this.writeQueue
  }

  private disconnect(error: Error, child?: ChildProcessWithoutNullStreams) {
    if (!this.process || (child && this.process !== child)) return
    this.process = undefined
    this.started = false
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.onDisconnect(error)
  }
}

function remoteWorkerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (isControllerCredentialEnvironmentKey(key)) delete env[key]
  return env
}
