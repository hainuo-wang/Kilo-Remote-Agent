import type {
  FileResult,
  GrepResult,
  ListResult,
  PtyAccepted,
  ProcessAccepted,
  ProcessExit,
  RpcEvent,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  StatResult,
  WriteResult,
} from "@kilocode/kilo-remote-protocol"
import { isRpcMessage, RPC_VERSION } from "@kilocode/kilo-remote-protocol"
import WebSocket from "ws"

type StreamHandler = {
  event: (event: RpcEvent) => void
  resolve: (exit: ProcessExit) => void
  reject: (error: Error) => void
  cleanup?: () => void
  lastSeq: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

class Client {
  private socket: WebSocket | undefined
  private connecting: Promise<WebSocket> | undefined
  private writeQueue = Promise.resolve()
  private workerEpoch: string | undefined
  private readonly responses = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >()
  private readonly streams = new Map<string, StreamHandler>()

  async request<T>(method: string, params: unknown, signal?: AbortSignal, deadline?: number): Promise<T> {
    const requestId = crypto.randomUUID()
    const response = await this.send(
      { type: "request", version: RPC_VERSION, requestId, method, params, deadline },
      signal,
    )
    if (response.error) throw new RemoteRpcError(response.error.code, response.error.message)
    return response.result as T
  }

  async runProcess(
    params: { rootId: "workspace"; command: string; cwd: string; timeoutMs?: number },
    signal: AbortSignal,
    event: (event: RpcEvent) => void,
  ): Promise<{ accepted: ProcessAccepted; exit: ProcessExit }> {
    const requestId = crypto.randomUUID()
    const streamId = `${requestId}:process`
    let rejectTerminal!: (error: Error) => void
    const terminal = new Promise<ProcessExit>((resolve, reject) => {
      rejectTerminal = reject
      this.streams.set(streamId, { event, resolve, reject, lastSeq: -1 })
    })
    void terminal.catch(() => undefined)
    const abort = () => {
      rejectTerminal(abortError(signal))
      void this.write({ type: "cancel", version: RPC_VERSION, requestId, streamId })
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      const response = await this.send(
        {
          type: "request",
          version: RPC_VERSION,
          requestId,
          method: "process.run",
          params,
          ...(params.timeoutMs ? { deadline: Date.now() + params.timeoutMs } : {}),
        },
        signal,
        { defaultDeadline: false },
      )
      if (response.error) throw new RemoteRpcError(response.error.code, response.error.message)
      return { accepted: response.result as ProcessAccepted, exit: await terminal }
    } finally {
      signal.removeEventListener("abort", abort)
      this.streams.delete(streamId)
    }
  }

  async startPty(
    params: { rootId: "workspace"; command: string; cwd: string; shell?: string; cols?: number; rows?: number },
    signal: AbortSignal,
    event: (event: RpcEvent) => void,
  ): Promise<PtyAccepted> {
    const requestId = crypto.randomUUID()
    const streamId = `${requestId}:pty`
    const abort = () => {
      void this.write({ type: "cancel", version: RPC_VERSION, requestId, streamId })
    }
    signal.addEventListener("abort", abort, { once: true })
    this.streams.set(streamId, {
      event,
      resolve: () => undefined,
      reject: () => undefined,
      lastSeq: -1,
      cleanup: () => signal.removeEventListener("abort", abort),
    })
    try {
      const response = await this.send(
        {
          type: "request",
          version: RPC_VERSION,
          requestId,
          method: "pty.start",
          params,
        },
        signal,
      )
      if (response.error) throw new RemoteRpcError(response.error.code, response.error.message)
      return response.result as PtyAccepted
    } catch (error) {
      this.finishStream(streamId, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async ptyInput(streamId: string, data: string, signal?: AbortSignal): Promise<void> {
    await this.request("pty.input", { streamId, data: Buffer.from(data, "utf8").toString("base64") }, signal)
  }

  async ptyResize(streamId: string, cols: number, rows: number, signal?: AbortSignal): Promise<void> {
    await this.request("pty.resize", { streamId, cols, rows }, signal)
  }

  async ptyClose(streamId: string, signal?: AbortSignal): Promise<void> {
    await this.request("pty.close", { streamId }, signal)
  }

  private async send(request: RpcRequest, signal?: AbortSignal, options?: { defaultDeadline?: boolean }) {
    if (signal?.aborted) throw abortError(signal)
    const outbound =
      request.deadline === undefined && options?.defaultDeadline !== false
        ? { ...request, deadline: Date.now() + DEFAULT_REQUEST_TIMEOUT_MS }
        : request
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.responses.set(outbound.requestId, { resolve, reject })
    })
    const abort = () => {
      const pending = this.responses.get(outbound.requestId)
      this.responses.delete(outbound.requestId)
      pending?.reject(abortError(signal!))
      void this.write({ type: "cancel", version: RPC_VERSION, requestId: outbound.requestId })
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      await this.write(outbound)
      return await response
    } finally {
      signal?.removeEventListener("abort", abort)
      this.responses.delete(outbound.requestId)
    }
  }

  private async write(message: RpcMessage) {
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const socket = await this.connect()
        if (socket.readyState !== WebSocket.OPEN) throw new Error("Remote tool bridge is not open")
        socket.send(JSON.stringify(message))
      })
    this.writeQueue = operation
    return operation
  }

  dispose() {
    this.disconnect(new Error("Remote worker client disposed"))
  }

  private connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting
    const base = process.env.KILO_REMOTE_BRIDGE_URL
    const token = process.env.KILO_REMOTE_BRIDGE_TOKEN
    if (!base || !token) return Promise.reject(new Error("Remote tool bridge is not configured"))
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const url = new URL(base)
      url.searchParams.set("token", token)
      const socket = new WebSocket(url)
      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error("Remote tool bridge connection timed out"))
      }, 10_000)
      socket.once("open", () => {
        clearTimeout(timeout)
        this.socket = socket
        resolve(socket)
      })
      socket.on("message", (data) => this.receive(data))
      socket.once("close", () => {
        if (this.socket === socket) this.disconnect(new Error("Remote tool bridge disconnected"))
      })
      socket.once("error", () => {
        clearTimeout(timeout)
        reject(new Error("Remote tool bridge connection failed"))
      })
    }).finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private receive(data: unknown) {
    try {
      const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8")
      const message: unknown = JSON.parse(text)
      if (!isRpcMessage(message)) throw new Error("Remote tool bridge returned an invalid message")
      if (message.type === "response") {
        this.responses.get(message.requestId)?.resolve(message)
        return
      }
      if (message.type !== "event") return
      if (message.event === "heartbeat" && message.streamId === "worker") {
        if (message.workerEpoch) this.workerEpoch = message.workerEpoch
        return
      }
      if (message.workerEpoch) {
        if (!this.workerEpoch) {
          this.workerEpoch = message.workerEpoch
        } else if (message.workerEpoch !== this.workerEpoch) {
          if (message.streamId !== "worker") {
            this.finishStream(
              message.streamId,
              new RemoteRpcError("REMOTE_DISCONNECTED", `Ignored stale remote worker event for ${message.streamId}`),
            )
          }
          return
        }
      }
      if (message.event === "closed" && message.streamId === "worker") {
        const data = message.data as { code?: string; message?: string }
        this.disconnect(
          new RemoteRpcError(data.code ?? "REMOTE_DISCONNECTED", data.message ?? "Remote worker disconnected"),
        )
        return
      }
      const stream = this.streams.get(message.streamId)
      if (!stream) return
      if (message.seq <= stream.lastSeq) return
      if (message.seq !== stream.lastSeq + 1) {
        this.finishStream(
          message.streamId,
          new Error(`Remote stream ${message.streamId} lost event sequence ${stream.lastSeq + 1}`),
        )
        return
      }
      stream.lastSeq = message.seq
      stream.event(message)
      if (message.event === "exit") {
        stream.resolve(message.data as ProcessExit)
        stream.cleanup?.()
        this.streams.delete(message.streamId)
      }
      if (message.event === "error") {
        const error = message.data as { code?: string; message?: string }
        this.finishStream(
          message.streamId,
          new RemoteRpcError(error.code ?? "PROCESS_FAILED", error.message ?? "Remote process failed"),
        )
        return
      }
      if (message.event === "closed") {
        const error = message.data as { code?: string; message?: string }
        this.finishStream(
          message.streamId,
          new RemoteRpcError(error.code ?? "REMOTE_DISCONNECTED", error.message ?? "Remote stream closed"),
        )
      }
    } catch (error) {
      this.disconnect(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private disconnect(error: Error) {
    const socket = this.socket
    this.socket = undefined
    this.workerEpoch = undefined
    if (socket && socket.readyState === WebSocket.OPEN) socket.close()
    for (const pending of this.responses.values()) pending.reject(error)
    this.responses.clear()
    for (const stream of this.streams.values()) {
      stream.cleanup?.()
      stream.reject(error instanceof RemoteRpcError ? error : new RemoteRpcError("REMOTE_DISCONNECTED", error.message))
    }
    this.streams.clear()
  }

  private finishStream(streamId: string, error: Error) {
    const stream = this.streams.get(streamId)
    if (!stream) return
    stream.cleanup?.()
    stream.reject(error)
    this.streams.delete(streamId)
  }
}

export class RemoteRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "RemoteRpcError"
  }
}

const client = new Client()

export namespace RemoteWorkerClient {
  export const enabled = () =>
    process.env.KILO_REMOTE_TOOL_HOST === "1" &&
    Boolean(process.env.KILO_REMOTE_BRIDGE_URL) &&
    Boolean(process.env.KILO_REMOTE_BRIDGE_TOKEN)

  export const readFile = (path: string, signal?: AbortSignal) =>
    client.request<FileResult>("fs.readFile", { rootId: "workspace", path }, signal)
  export const stat = (path: string, signal?: AbortSignal) =>
    client.request<StatResult>("fs.stat", { rootId: "workspace", path }, signal)
  export const listFiles = (path: string, recursive: boolean, limit: number, signal?: AbortSignal) =>
    client.request<ListResult>("fs.listFiles", { rootId: "workspace", path, recursive, limit }, signal)
  export const writeFile = (path: string, content: string, signal?: AbortSignal) =>
    client.request<WriteResult>(
      "fs.writeFile",
      { rootId: "workspace", path, content: { encoding: "base64", data: Buffer.from(content).toString("base64") } },
      signal,
    )
  export const editFile = (
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    signal?: AbortSignal,
  ) =>
    client.request<WriteResult>("fs.editFile", { rootId: "workspace", path, oldString, newString, replaceAll }, signal)
  export const grep = (
    input: { pattern: string; path: string; include?: string; limit?: number },
    signal?: AbortSignal,
  ) => client.request<GrepResult>("search.grep", { rootId: "workspace", ...input }, signal)
  export const runProcess = client.runProcess.bind(client)
  export const startPty = client.startPty.bind(client)
  export const ptyInput = client.ptyInput.bind(client)
  export const ptyResize = client.ptyResize.bind(client)
  export const ptyClose = client.ptyClose.bind(client)
  export const dispose = () => client.dispose()
}

function abortError(signal: AbortSignal) {
  const reason = signal.reason
  const error = new Error(reason instanceof Error ? reason.message : "Remote request cancelled")
  error.name = "AbortError"
  return error
}
