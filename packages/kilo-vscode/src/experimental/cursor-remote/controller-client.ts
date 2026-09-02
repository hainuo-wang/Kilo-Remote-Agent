import * as vscode from "vscode"
import type { ControllerHttpEvent, ControllerHttpRequest, ControllerHttpResponse } from "@kilocode/kilo-remote-protocol"
import { REMOTE_COMMANDS } from "@kilocode/kilo-remote-protocol"

const HTTP_HANDSHAKE_TIMEOUT_MS = 120_000

type StreamState = {
  requestId: string
  controller?: ReadableStreamDefaultController<Uint8Array>
  chunks: Uint8Array[]
  done: boolean
  lastSeq: number
  error?: Error
  cleanup?: () => void
}

export type CursorRemoteFetch = {
  baseUrl: string
  fetch: typeof fetch
  dispose: vscode.Disposable
}

export function createCursorRemoteFetch(context: vscode.ExtensionContext): CursorRemoteFetch | undefined {
  if (!isSshRemote()) return undefined
  if (!vscode.workspace.getConfiguration("kilo-code.new.experimental").get("cursorLikeRemote", false)) {
    return undefined
  }

  const streams = new Map<string, StreamState>()
  const eventDisposable = vscode.commands.registerCommand(
    REMOTE_COMMANDS.controllerHttpEvent,
    (event: ControllerHttpEvent) => {
      const stream = streams.get(event.streamId)
      if (!stream) return
      if (event.seq !== undefined) {
        if (event.seq <= stream.lastSeq) return
        if (event.seq !== stream.lastSeq + 1) {
          stream.error = new Error(`Local controller HTTP stream lost event sequence ${stream.lastSeq + 1}`)
          stream.controller?.error(stream.error)
          stream.cleanup?.()
          return
        }
        stream.lastSeq = event.seq
      }
      if (event.event === "chunk") {
        const chunk = Buffer.from(event.data.chunk, "base64")
        if (stream.controller) stream.controller.enqueue(chunk)
        else stream.chunks.push(chunk)
        return
      }
      if (event.event === "end") {
        stream.done = true
        if (stream.controller) {
          stream.controller.close()
          stream.cleanup?.()
        }
        return
      }
      stream.error = new Error(event.error.message)
      stream.controller?.error(stream.error)
      if (stream.controller) stream.cleanup?.()
    },
  )

  const remoteFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const requestId = crypto.randomUUID()
    const streamId = `http:${requestId}`
    const stream: StreamState = { requestId, chunks: [], done: false, lastSeq: -1 }
    streams.set(streamId, stream)

    const abort = () => {
      stream.error = abortError(request.signal)
      stream.controller?.error(stream.error)
      void vscode.commands.executeCommand(REMOTE_COMMANDS.controllerHttpCancel, { requestId })
    }
    request.signal.addEventListener("abort", abort, { once: true })

    try {
      if (request.signal.aborted) throw abortError(request.signal)
      const body = request.body ? Buffer.from(await request.arrayBuffer()).toString("base64") : undefined
      const descriptor = await controllerHttpRequest(
        {
          requestId,
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers.entries()),
          ...(body ? { body } : {}),
        } satisfies ControllerHttpRequest,
        request.signal,
      )
      if (request.signal.aborted) throw abortError(request.signal)
      if (!descriptor || typeof descriptor.status !== "number") {
        throw new Error("Local Kilo controller returned an invalid HTTP response")
      }

      if (!descriptor.streamId) {
        streams.delete(streamId)
        request.signal.removeEventListener("abort", abort)
        return new Response(null, {
          status: descriptor.status,
          statusText: descriptor.statusText,
          headers: descriptor.headers,
        })
      }

      stream.cleanup = () => {
        request.signal.removeEventListener("abort", abort)
        streams.delete(streamId)
      }
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller
          for (const chunk of stream.chunks.splice(0)) controller.enqueue(chunk)
          if (stream.error) controller.error(stream.error)
          else if (stream.done) controller.close()
          if (stream.done || stream.error) stream.cleanup?.()
        },
        cancel() {
          void vscode.commands.executeCommand(REMOTE_COMMANDS.controllerHttpCancel, { requestId })
          stream.cleanup?.()
        },
      })
      return new Response(bodyStream, {
        status: descriptor.status,
        statusText: descriptor.statusText,
        headers: descriptor.headers,
      })
    } catch (error) {
      request.signal.removeEventListener("abort", abort)
      streams.delete(streamId)
      throw error
    }
  }

  return {
    baseUrl: "http://kilo-controller.invalid",
    fetch: remoteFetch,
    dispose: new vscode.Disposable(() => {
      for (const stream of streams.values()) stream.controller?.error(new Error("Remote controller disposed"))
      streams.clear()
      eventDisposable.dispose()
    }),
  }
}

function isSshRemote(): boolean {
  return vscode.env.remoteName?.startsWith("ssh-remote") ?? false
}

function abortError(signal: AbortSignal) {
  const error = signal.reason instanceof Error ? signal.reason : new Error("Remote controller request cancelled")
  error.name = "AbortError"
  return error
}

async function controllerHttpRequest(
  input: ControllerHttpRequest,
  signal: AbortSignal,
): Promise<ControllerHttpResponse> {
  const deadline = Date.now() + HTTP_HANDSHAKE_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    if (signal.aborted) throw abortError(signal)
    try {
      const response = await vscode.commands.executeCommand<ControllerHttpResponse>(
        REMOTE_COMMANDS.controllerHttp,
        input,
      )
      if (response && typeof response.status === "number") return response
      lastError = new Error("Local Kilo controller is not ready")
    } catch (error) {
      if (!isCommandUnavailable(error)) throw error
      lastError = error
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(250, remaining), signal)
  }
  void Promise.resolve(
    vscode.commands.executeCommand(REMOTE_COMMANDS.controllerHttpCancel, { requestId: input.requestId }),
  ).catch(() => undefined)
  throw lastError instanceof Error
    ? lastError
    : new Error(`Local controller HTTP handshake timed out after ${HTTP_HANDSHAKE_TIMEOUT_MS}ms`)
}

function isCommandUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /command .*not found|command .*not registered|no such command/i.test(message)
}

async function delay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, timeoutMs)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
