import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import * as vscode from "vscode"
import type {
  ControllerHttpEvent,
  ControllerHttpRequest,
  ControllerHttpResponse,
  ControllerPtyCloseRequest,
  ControllerPtyCreateRequest,
  ControllerPtyCreateResponse,
  ControllerPtyResizeRequest,
  PtyAccepted,
  RpcEvent,
  RpcError,
  RpcRequest,
  RpcResponse,
} from "@kilocode/kilo-remote-protocol"
import {
  isControllerCredentialEnvironmentKey,
  isRpcMessage,
  REMOTE_COMMANDS,
  RPC_VERSION,
} from "@kilocode/kilo-remote-protocol"
import { LocalServerManager } from "./local-server-manager"
import { rewriteJsonDirectories } from "./json-directory-rewriter"
import { miofficeControllerEnv } from "./mioffice"
import {
  containsLiteralCredential,
  isCredentialResponsePath,
  isCredentialRequestPath,
  isProviderCatalogPath,
  sanitizeCredentialPayload,
  sanitizeCredentialValue,
  sanitizeProviderCatalog,
} from "./provider-credential-sanitizer"
import { StreamingSecretRedactor } from "./secret-redactor"
import { StreamingSseDirectoryRewriter } from "./sse-directory-rewriter"
import { rewriteWorkspaceDirectory, virtualWorkspaceDirectory } from "./workspace-routing"

export const HTTP_COMMAND = REMOTE_COMMANDS.controllerHttp
export const HTTP_CANCEL_COMMAND = REMOTE_COMMANDS.controllerHttpCancel
const WORKER_HEARTBEAT_TIMEOUT_MS = 20_000
const WORKER_HEARTBEAT_CHECK_INTERVAL_MS = 5_000
const WORKER_COMMAND_HANDSHAKE_TIMEOUT_MS = 30_000
const PTY_BUFFER_LIMIT = 4 * 1024 * 1024
const PTY_STATE_TTL_MS = 5 * 60_000

type PtyState = {
  requestId: string
  streamId: string
  socket?: WebSocket
  queue: Buffer[]
  queuedBytes: number
  draining: boolean
  finished: boolean
  closeWhenDrained: boolean
  inputQueue: Promise<void>
  cleanupTimer?: ReturnType<typeof setTimeout>
}

export class ControllerBridge implements vscode.Disposable {
  private readonly token = randomBytes(32).toString("hex")
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  private readonly clients = new Set<WebSocket>()
  private readonly clientWrites = new Map<WebSocket, Promise<void>>()
  private readonly clientRequests = new Map<WebSocket, Map<string, string>>()
  private readonly clientStreams = new Map<WebSocket, Map<string, string>>()
  private readonly ready: Promise<number>
  private readonly serverManager: LocalServerManager
  private readonly httpRequests = new Map<string, AbortController>()
  private readonly workerHeartbeatTimer: ReturnType<typeof setInterval>
  private readonly context: vscode.ExtensionContext
  private readonly sensitiveValues = new Set<string>()
  private readonly ptys = new Map<string, PtyState>()
  private lastWorkerHeartbeat = Date.now()
  private workerUnavailable = false

  constructor(context: vscode.ExtensionContext) {
    this.context = context
    this.sensitiveValues.add(this.token)
    const configuredCli = vscode.workspace.getConfiguration("kilo-code").get<string>("remoteController.cliPath")?.trim()
    const bundledCli = path.join(context.extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
    const mainExtension = vscode.extensions.getExtension("kilocode.kilo-code")
    const fallbackCli =
      mainExtension?.extensionPath &&
      path.join(mainExtension.extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
    this.serverManager = new LocalServerManager({
      context,
      cliPath:
        configuredCli ||
        (existsSync(bundledCli) ? bundledCli : undefined) ||
        (fallbackCli && existsSync(fallbackCli) ? fallbackCli : undefined),
      onExit: (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
        console.warn(`[Kilo Remote Controller] Local backend exited with ${reason}`)
      },
      env: () => this.controllerEnv(),
    })
    this.ready = new Promise((resolve, reject) => {
      this.server.once("listening", () => {
        const address = this.server.address()
        if (!address || typeof address === "string") {
          reject(new Error("Controller bridge did not bind a TCP port"))
          return
        }
        resolve(address.port)
      })
      this.server.once("error", reject)
    })
    this.server.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", "ws://127.0.0.1")
      if (url.searchParams.get("token") !== this.token) {
        socket.close(1008, "Unauthorized")
        return
      }
      if (url.pathname === "/pty") {
        this.acceptPtySocket(socket, url)
        return
      }
      this.clients.add(socket)
      this.clientRequests.set(socket, new Map())
      this.clientStreams.set(socket, new Map())
      socket.on("message", (data) => void this.receive(socket, data))
      socket.once("close", () => {
        this.cancelClientRequests(socket)
        this.cancelClientStreams(socket)
        this.clients.delete(socket)
        this.clientWrites.delete(socket)
        this.clientRequests.delete(socket)
        this.clientStreams.delete(socket)
      })
    })
    this.workerHeartbeatTimer = setInterval(() => {
      if (this.workerUnavailable || Date.now() - this.lastWorkerHeartbeat <= WORKER_HEARTBEAT_TIMEOUT_MS) return
      this.workerUnavailable = true
      void this.forward({
        type: "event",
        version: RPC_VERSION,
        streamId: "worker",
        seq: 0,
        event: "closed",
        data: { code: "REMOTE_DISCONNECTED", message: "Remote worker heartbeat timed out" },
      }).catch(() => undefined)
    }, WORKER_HEARTBEAT_CHECK_INTERVAL_MS)
  }

  async env(): Promise<Record<string, string>> {
    const port = await this.ready
    return {
      KILO_REMOTE_TOOL_HOST: "1",
      KILO_REMOTE_BRIDGE_URL: `ws://127.0.0.1:${port}`,
      KILO_REMOTE_BRIDGE_TOKEN: this.token,
    }
  }

  private async controllerEnv(): Promise<Record<string, string>> {
    for (const [key, value] of Object.entries(process.env)) {
      if (value && isControllerCredentialEnvironmentKey(key)) this.sensitiveValues.add(value)
    }
    const env = {
      ...(await this.env()),
      ...(await miofficeControllerEnv(true, this.context)),
    }
    for (const key of ["MIOFFICE_API_KEY", "KILO_REMOTE_BRIDGE_TOKEN"]) {
      const value = env[key]
      if (value) this.sensitiveValues.add(value)
    }
    return env
  }

  async http(request: ControllerHttpRequest): Promise<ControllerHttpResponse> {
    const parsed = new URL(request.url)
    if (parsed.origin !== "http://kilo-controller.invalid") {
      throw new Error("Controller HTTP requests must use the local controller origin")
    }
    const server = await this.serverManager.getServer()
    this.sensitiveValues.add(server.password)

    const abort = new AbortController()
    this.httpRequests.set(request.requestId, abort)
    let bodyIsStreaming = false
    try {
      const headers = { ...request.headers }
      for (const key of Object.keys(headers)) {
        if (/^(?:host|content-length)$/i.test(key) || /(?:authorization|api[-_]?key|token|secret|password)/i.test(key))
          delete headers[key]
      }
      if (isCredentialRequestPath(parsed.pathname) && request.body) {
        let body: unknown
        try {
          body = JSON.parse(Buffer.from(request.body, "base64").toString("utf8"))
        } catch {
          body = undefined
        }
        if (containsLiteralCredential(body)) {
          throw new Error(
            "Remote credential updates are disabled; configure provider credentials in the local controller.",
          )
        }
      }
      const remoteDirectory = findRemoteDirectory(request, parsed)
      const directoryMapping = remoteDirectory
        ? { virtualDirectory: this.virtualDirectory(remoteDirectory), remoteDirectory }
        : undefined
      if (remoteDirectory) {
        headers["x-kilo-directory"] = encodeURIComponent(directoryMapping!.virtualDirectory)
        headers["x-kilo-remote-directory"] = encodeURIComponent(remoteDirectory)
        rewriteWorkspaceDirectory(parsed, directoryMapping!.virtualDirectory)
      }
      headers.Authorization = `Basic ${Buffer.from(`kilo:${server.password}`).toString("base64")}`
      const response = await fetch(`http://127.0.0.1:${server.port}${parsed.pathname}${parsed.search}`, {
        method: request.method,
        headers,
        body: request.body ? Buffer.from(request.body, "base64") : undefined,
        signal: abort.signal,
      })
      const result: ControllerHttpResponse = {
        status: response.status,
        statusText: response.statusText,
        headers: this.redactHeaders(Object.fromEntries(response.headers.entries()), Boolean(response.body)),
      }
      if (!response.body) return result

      const streamId = `http:${request.requestId}`
      bodyIsStreaming = true
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      void this.forwardHttpBody(
        request.requestId,
        streamId,
        response.body,
        abort.signal,
        contentType,
        directoryMapping,
        parsed.pathname,
      )
      return { ...result, streamId }
    } finally {
      if (!bodyIsStreaming) this.httpRequests.delete(request.requestId)
    }
  }

  async ptyCreate(request: ControllerPtyCreateRequest): Promise<ControllerPtyCreateResponse> {
    if (!request || typeof request.cwd !== "string" || request.cwd.length === 0) {
      throw new Error("Remote PTY cwd is required")
    }
    const requestId = crypto.randomUUID()
    const streamId = `${requestId}:pty`
    const state: PtyState = {
      requestId,
      streamId,
      queue: [],
      queuedBytes: 0,
      draining: false,
      finished: false,
      closeWhenDrained: false,
      inputQueue: Promise.resolve(),
    }
    this.ptys.set(streamId, state)
    try {
      const response = await this.request({
        type: "request",
        version: RPC_VERSION,
        requestId,
        method: "pty.start",
        params: {
          rootId: "workspace",
          cwd: request.cwd,
          ...(request.cols === undefined ? {} : { cols: request.cols }),
          ...(request.rows === undefined ? {} : { rows: request.rows }),
          ...(request.shell === undefined ? {} : { shell: request.shell }),
        },
      })
      if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`)
      const accepted = response.result as PtyAccepted
      if (!accepted || accepted.streamId !== streamId) throw new Error("Remote worker returned an invalid PTY")
      const port = await this.ready
      return {
        streamId,
        wsUrl: `ws://127.0.0.1:${port}/pty?token=${this.token}&streamId=${encodeURIComponent(streamId)}`,
        pid: accepted.pid,
        cwd: accepted.cwd,
      }
    } catch (error) {
      this.disposePty(streamId)
      throw error
    }
  }

  async ptyResize(request: ControllerPtyResizeRequest): Promise<void> {
    const state = this.requirePty(request.streamId)
    const response = await this.request({
      type: "request",
      version: RPC_VERSION,
      requestId: crypto.randomUUID(),
      method: "pty.resize",
      params: { streamId: state.streamId, cols: request.cols, rows: request.rows },
    })
    if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`)
  }

  async ptyClose(request: ControllerPtyCloseRequest): Promise<void> {
    const state = this.requirePty(request.streamId)
    const response = await this.request({
      type: "request",
      version: RPC_VERSION,
      requestId: crypto.randomUUID(),
      method: "pty.close",
      params: { streamId: state.streamId },
    })
    if (response.error && response.error.code !== "PTY_NOT_FOUND") {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }
    this.finishPty(state)
  }

  cancelHttp(requestId: string): void {
    this.httpRequests.get(requestId)?.abort()
  }

  async forward(event: RpcEvent & { workerEpoch?: string }): Promise<void> {
    if (event.streamId === "worker" && event.event === "heartbeat") {
      this.lastWorkerHeartbeat = Date.now()
      this.workerUnavailable = false
    }
    if (event.streamId === "worker" && event.event === "closed") {
      for (const streams of this.clientStreams.values()) streams.clear()
      for (const pty of this.ptys.values()) this.finishPty(pty)
    } else if (event.event === "exit" || event.event === "error" || event.event === "closed") {
      for (const streams of this.clientStreams.values()) streams.delete(event.streamId)
    }
    const data = JSON.stringify(event)
    await Promise.all([...this.clients].map((client) => this.write(client, data)))
    const pty = this.ptys.get(event.streamId)
    if (!pty) return
    if (event.event === "stdout") {
      const output = event.data as { encoding?: string; chunk?: string }
      if (output.encoding === "base64" && typeof output.chunk === "string") {
        this.enqueuePtyOutput(pty, Buffer.from(output.chunk, "base64"))
      }
      return
    }
    if (event.event === "exit" || event.event === "error" || event.event === "closed") {
      this.finishPty(pty)
    }
  }

  dispose(): void {
    clearInterval(this.workerHeartbeatTimer)
    for (const request of this.httpRequests.values()) request.abort()
    this.httpRequests.clear()
    this.serverManager.dispose()
    for (const client of this.clients) {
      this.cancelClientRequests(client)
      this.cancelClientStreams(client)
      client.close(1001, "Controller bridge disposed")
    }
    this.clients.clear()
    this.clientWrites.clear()
    this.clientRequests.clear()
    this.clientStreams.clear()
    for (const streamId of this.ptys.keys()) this.disposePty(streamId)
    this.ptys.clear()
    this.server.close()
  }

  private acceptPtySocket(socket: WebSocket, url: URL): void {
    const streamId = url.searchParams.get("streamId")
    if (!streamId) {
      socket.close(1008, "Missing PTY stream")
      return
    }
    const state = this.ptys.get(streamId)
    if (!state) {
      socket.close(1008, "Unknown PTY stream")
      return
    }
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.close(4009, "PTY already attached")
    }
    state.socket = socket
    socket.on("message", (data) => this.enqueuePtyInput(state, data))
    socket.once("close", () => {
      if (state.socket === socket) state.socket = undefined
    })
    this.drainPty(state)
  }

  private enqueuePtyInput(state: PtyState, data: RawData): void {
    if (state.finished) return
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (bytes.byteLength === 0) return
    state.inputQueue = state.inputQueue
      .catch(() => undefined)
      .then(async () => {
        const response = await this.request({
          type: "request",
          version: RPC_VERSION,
          requestId: crypto.randomUUID(),
          method: "pty.input",
          params: {
            streamId: state.streamId,
            data: bytes.toString("base64"),
          },
        })
        if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`)
      })
      .catch((error) => {
        this.finishPty(state)
        if (state.socket?.readyState === WebSocket.OPEN) state.socket.close(1011, errorMessage(error))
      })
  }

  private requirePty(streamId: string): PtyState {
    const state = this.ptys.get(streamId)
    if (!state) throw new Error(`Remote PTY stream not found: ${streamId}`)
    return state
  }

  private enqueuePtyOutput(state: PtyState, data: Buffer): void {
    if (data.byteLength > 0) {
      state.queue.push(data)
      state.queuedBytes += data.byteLength
      while (state.queuedBytes > PTY_BUFFER_LIMIT && state.queue.length > 1) {
        const removed = state.queue.shift()!
        state.queuedBytes -= removed.byteLength
      }
    }
    this.drainPty(state)
  }

  private drainPty(state: PtyState): void {
    if (state.draining || !state.socket || state.socket.readyState !== WebSocket.OPEN) return
    state.draining = true
    void (async () => {
      try {
        while (state.socket && state.socket.readyState === WebSocket.OPEN && state.queue.length > 0) {
          const frame = state.queue.shift()!
          state.queuedBytes -= frame.byteLength
          await this.writeBinary(state.socket, frame)
        }
        if (state.closeWhenDrained && state.queue.length === 0 && state.socket?.readyState === WebSocket.OPEN) {
          state.socket.close(1000, "PTY exited")
        }
      } finally {
        state.draining = false
        if (state.socket && state.queue.length > 0) this.drainPty(state)
      }
    })().catch(() => undefined)
  }

  private writeBinary(socket: WebSocket, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        resolve()
        return
      }
      socket.send(data, (error) => (error ? reject(error) : resolve()))
    })
  }

  private finishPty(state: PtyState): void {
    if (state.finished) return
    state.finished = true
    state.closeWhenDrained = true
    this.drainPty(state)
    state.cleanupTimer = setTimeout(() => this.disposePty(state.streamId), PTY_STATE_TTL_MS)
    state.cleanupTimer.unref()
  }

  private disposePty(streamId: string): void {
    const state = this.ptys.get(streamId)
    if (!state) return
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer)
    if (!state.finished) void this.cancelRemoteRequest(state.requestId, state.streamId)
    state.socket?.close(1000, "PTY disposed")
    this.ptys.delete(streamId)
  }

  private write(client: WebSocket, data: string): Promise<void> {
    const previous = this.clientWrites.get(client) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (client.readyState !== WebSocket.OPEN) {
              resolve()
              return
            }
            let settled = false
            const finish = (error?: Error) => {
              if (settled) return
              settled = true
              client.off("close", onClose)
              client.off("error", onError)
              if (error) reject(error)
              else resolve()
            }
            const onClose = () => finish(new Error("Remote worker bridge socket closed while sending"))
            const onError = (error: Error) => finish(error)
            client.once("close", onClose)
            client.once("error", onError)
            client.send(data, finish)
          }),
      )
    this.clientWrites.set(client, operation)
    void operation
      .finally(() => {
        if (this.clientWrites.get(client) === operation) this.clientWrites.delete(client)
      })
      .catch(() => undefined)
    return operation
  }

  private async receive(socket: WebSocket, data: RawData) {
    let message: unknown
    try {
      message = JSON.parse(data.toString())
    } catch {
      socket.close(1003, "Invalid JSON")
      return
    }
    if (!isRpcMessage(message)) {
      socket.close(1003, "Invalid RPC message")
      return
    }
    if (message.type === "cancel") {
      await this.cancelRemoteRequest(message.requestId, message.streamId)
      return
    }
    if (message.type !== "request") return
    this.clientRequests.get(socket)?.set(message.requestId, message.method)
    const streamId = requestStreamId(message.method, message.requestId)
    if (streamId) this.clientStreams.get(socket)?.set(streamId, message.requestId)
    try {
      const response = await this.request(message)
      if (response.error && streamId) {
        this.clientStreams.get(socket)?.delete(streamId)
      }
      if (socket.readyState === WebSocket.OPEN) await this.write(socket, JSON.stringify(response))
    } catch {
      if (socket.readyState === WebSocket.OPEN) {
        await this.write(
          socket,
          JSON.stringify({
            type: "response",
            version: message.version,
            requestId: message.requestId,
            error: {
              code: "REMOTE_DISCONNECTED",
              message: "Remote worker bridge request failed",
            },
          } satisfies RpcResponse),
        ).catch(() => undefined)
      }
    } finally {
      this.clientRequests.get(socket)?.delete(message.requestId)
    }
  }

  private cancelClientRequests(socket: WebSocket): void {
    const requests = this.clientRequests.get(socket)
    if (!requests) return
    for (const [requestId, method] of requests) {
      if (method !== "process.run" && method !== "pty.start") continue
      void this.cancelRemoteRequest(requestId)
    }
  }

  private cancelClientStreams(socket: WebSocket): void {
    const streams = this.clientStreams.get(socket)
    if (!streams) return
    for (const [streamId, requestId] of streams) {
      void this.cancelRemoteRequest(requestId, streamId)
    }
  }

  private async cancelRemoteRequest(requestId: string, streamId?: string): Promise<void> {
    await Promise.resolve(
      vscode.commands.executeCommand(REMOTE_COMMANDS.cancel, {
        requestId,
        ...(streamId ? { streamId } : {}),
      }),
    ).catch(() => undefined)
  }

  private async request(request: RpcRequest): Promise<RpcResponse> {
    const deadline = Date.now() + WORKER_COMMAND_HANDSHAKE_TIMEOUT_MS
    let lastError: unknown
    let timedOut = false
    try {
      while (Date.now() < deadline) {
        try {
          return await vscode.commands.executeCommand<RpcResponse>(REMOTE_COMMANDS.request, request)
        } catch (error) {
          if (!isCommandUnavailable(error)) throw error
          lastError = error
          await delay(250)
        }
      }
      timedOut = true
    } catch (error) {
      lastError = error
    } finally {
      if (timedOut) {
        await this.cancelRemoteRequest(request.requestId, requestStreamId(request.method, request.requestId))
      }
    }
    return {
      type: "response",
      version: request.version,
      requestId: request.requestId,
      error: {
        code: timedOut ? "TIMEOUT" : requestErrorCode(lastError),
        message: timedOut
          ? `Remote worker command timed out: ${request.method}`
          : lastError instanceof Error
            ? lastError.message
            : `Remote worker command was unavailable for ${WORKER_COMMAND_HANDSHAKE_TIMEOUT_MS}ms`,
      },
    }
  }

  private async forwardHttpBody(
    requestId: string,
    streamId: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    contentType?: string,
    directoryMapping?: { virtualDirectory: string; remoteDirectory: string },
    pathname?: string,
  ) {
    const reader = body.getReader()
    const redactor = new StreamingSecretRedactor(this.sensitiveValues)
    const sseRewriter =
      contentType === "text/event-stream" && (directoryMapping || (pathname && isCredentialResponsePath(pathname)))
        ? new StreamingSseDirectoryRewriter(
            directoryMapping?.virtualDirectory,
            directoryMapping?.remoteDirectory,
            pathname && isCredentialResponsePath(pathname) ? sanitizeCredentialValue : undefined,
          )
        : undefined
    const jsonChunks: Buffer[] | undefined =
      contentType !== "text/event-stream" && (directoryMapping || (pathname && isCredentialResponsePath(pathname)))
        ? []
        : undefined
    let sequence = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        if (next.value.byteLength === 0) continue
        if (jsonChunks) {
          jsonChunks.push(Buffer.from(next.value))
          continue
        }
        const rewritten = sseRewriter?.write(next.value) ?? Buffer.from(next.value)
        const chunk = redactor.write(rewritten)
        if (chunk.byteLength > 0) await this.forwardHttpChunk(streamId, sequence++, chunk)
      }
      if (!signal.aborted) {
        let rewrittenFinal = jsonChunks ? Buffer.concat(jsonChunks) : (sseRewriter?.end() ?? Buffer.alloc(0))
        if (directoryMapping) {
          rewrittenFinal = rewriteJsonDirectories(
            rewrittenFinal,
            directoryMapping.virtualDirectory,
            directoryMapping.remoteDirectory,
          )
        }
        if (pathname && isProviderCatalogPath(pathname)) rewrittenFinal = sanitizeProviderCatalog(rewrittenFinal)
        else if (pathname && isCredentialResponsePath(pathname))
          rewrittenFinal = sanitizeCredentialPayload(rewrittenFinal)
        const finalRewritten = redactor.write(rewrittenFinal)
        if (finalRewritten.byteLength > 0) await this.forwardHttpChunk(streamId, sequence++, finalRewritten)
        const final = redactor.end()
        if (final.byteLength > 0) await this.forwardHttpChunk(streamId, sequence++, final)
        await vscode.commands.executeCommand(REMOTE_COMMANDS.controllerHttpEvent, {
          streamId,
          event: "end",
          seq: sequence++,
        } satisfies ControllerHttpEvent)
      }
    } catch (error) {
      if (!signal.aborted) {
        await Promise.resolve(
          vscode.commands.executeCommand(REMOTE_COMMANDS.controllerHttpEvent, {
            streamId,
            event: "error",
            seq: sequence++,
            error: { message: error instanceof Error ? error.message : String(error) },
          } satisfies ControllerHttpEvent),
        ).catch(() => undefined)
      }
    } finally {
      reader.releaseLock()
      this.httpRequests.delete(requestId)
    }
  }

  private virtualDirectory(remoteDirectory: string) {
    const workspaceAuthority =
      vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? vscode.workspace.workspaceFile?.authority ?? "local"
    return virtualWorkspaceDirectory(
      this.context.globalStorageUri.fsPath,
      vscode.env.remoteName,
      workspaceAuthority,
      remoteDirectory,
    )
  }

  private forwardHttpChunk(streamId: string, seq: number, chunk: Buffer) {
    return vscode.commands.executeCommand(REMOTE_COMMANDS.controllerHttpEvent, {
      streamId,
      event: "chunk",
      seq,
      data: { encoding: "base64", chunk: chunk.toString("base64") },
    } satisfies ControllerHttpEvent)
  }

  private redactHeaders(headers: Record<string, string>, hasBody: boolean): Record<string, string> {
    const redactor = new StreamingSecretRedactor(this.sensitiveValues)
    const result = Object.fromEntries(
      Object.entries(headers)
        .filter(([key]) => !/(?:authorization|api[-_]?key|token|secret|password)/i.test(key))
        .map(([key, value]) => [key, redactor.redactText(value)]),
    )
    if (hasBody) {
      for (const key of ["content-length", "content-encoding", "content-md5", "content-range", "etag"])
        delete result[key]
    }
    return result
  }
}

function requestErrorCode(error: unknown): RpcError["code"] {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
  if (code === "TIMEOUT" || code === "CANCELLED") return code
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout|deadline/i.test(message)) return "TIMEOUT"
  return "REMOTE_DISCONNECTED"
}

function requestStreamId(method: string, requestId: string): string | undefined {
  if (method === "process.run") return `${requestId}:process`
  if (method === "pty.start") return `${requestId}:pty`
  return undefined
}

function findRemoteDirectory(request: ControllerHttpRequest, url: URL): string | undefined {
  const header = request.headers["x-kilo-directory"] ?? request.headers["X-Kilo-Directory"]
  if (header) return decodeHeaderValue(header)
  const value = url.searchParams.get("directory") ?? url.searchParams.get("location[directory]")
  if (value === null) return undefined
  return value
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isCommandUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /command .*not found|command .*not registered|no such command/i.test(message)
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
