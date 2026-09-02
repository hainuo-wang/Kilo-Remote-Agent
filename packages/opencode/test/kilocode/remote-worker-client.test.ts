import { afterEach, describe, expect, test } from "bun:test"
import { WebSocketServer } from "ws"
import type { RpcMessage } from "@kilocode/kilo-remote-protocol"
import { RPC_VERSION } from "@kilocode/kilo-remote-protocol"
import { RemoteWorkerClient } from "@/kilocode/remote-worker/client"

const environment = {
  toolHost: process.env.KILO_REMOTE_TOOL_HOST,
  bridgeUrl: process.env.KILO_REMOTE_BRIDGE_URL,
  bridgeToken: process.env.KILO_REMOTE_BRIDGE_TOKEN,
}

afterEach(() => {
  RemoteWorkerClient.dispose()
  restore("KILO_REMOTE_TOOL_HOST", environment.toolHost)
  restore("KILO_REMOTE_BRIDGE_URL", environment.bridgeUrl)
  restore("KILO_REMOTE_BRIDGE_TOKEN", environment.bridgeToken)
})

describe("remote worker client", () => {
  test("cancels a request while waiting for the worker response", async () => {
    const requests: RpcMessage[] = []
    const received = deferred<RpcMessage>()
    const server = await bridge((message) => {
      requests.push(message)
      received.resolve(message)
    })
    try {
      const abort = new AbortController()
      const running = RemoteWorkerClient.runProcess(
        { rootId: "workspace", command: "sleep 30", cwd: "." },
        abort.signal,
        () => undefined,
      )
      await received.promise
      abort.abort()

      await expect(running).rejects.toMatchObject({ name: "AbortError" })
      await waitFor(() => requests.some((message) => message.type === "cancel"))
      expect(requests.some((message) => message.type === "cancel")).toBe(true)
    } finally {
      RemoteWorkerClient.dispose()
      await close(server)
    }
  })

  test("does not add a default execution deadline to process requests", async () => {
    let receivedRequest: RpcMessage | undefined
    const server = await bridge((message, socket) => {
      if (message.type !== "request" || message.method !== "process.run") return
      receivedRequest = message
      socket.send(
        JSON.stringify({
          type: "response",
          version: RPC_VERSION,
          requestId: message.requestId,
          result: { streamId: `${message.requestId}:process`, command: "sleep 60", cwd: "." },
        }),
      )
      socket.send(
        JSON.stringify({
          type: "event",
          version: RPC_VERSION,
          streamId: `${message.requestId}:process`,
          seq: 0,
          event: "exit",
          data: { exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0, truncated: false },
        }),
      )
    })
    try {
      const result = await RemoteWorkerClient.runProcess(
        { rootId: "workspace", command: "sleep 60", cwd: "." },
        new AbortController().signal,
        () => undefined,
      )
      expect(result.exit.exitCode).toBe(0)
      expect(receivedRequest).toBeDefined()
      expect(receivedRequest).not.toHaveProperty("deadline")
    } finally {
      await close(server)
    }
  })

  test("rejects a stream when an event sequence is lost", async () => {
    const server = await bridge((message, socket) => {
      if (message.type !== "request" || message.method !== "process.run") return
      socket.send(
        JSON.stringify({
          type: "response",
          version: RPC_VERSION,
          requestId: message.requestId,
          result: { streamId: `${message.requestId}:process`, command: "test", cwd: "." },
        }),
      )
      socket.send(
        JSON.stringify({
          type: "event",
          version: RPC_VERSION,
          streamId: `${message.requestId}:process`,
          seq: 0,
          event: "stdout",
          data: { encoding: "base64", chunk: Buffer.from("first").toString("base64") },
        }),
      )
      socket.send(
        JSON.stringify({
          type: "event",
          version: RPC_VERSION,
          streamId: `${message.requestId}:process`,
          seq: 2,
          event: "exit",
          data: { exitCode: 0, signal: null, stdoutBytes: 5, stderrBytes: 0, truncated: false },
        }),
      )
    })
    try {
      await expect(
        RemoteWorkerClient.runProcess(
          { rootId: "workspace", command: "test", cwd: "." },
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toThrow("lost event sequence 1")
    } finally {
      RemoteWorkerClient.dispose()
      await close(server)
    }
  })

  test("rejects active streams when the remote bridge disconnects", async () => {
    let connections = 0
    const server = await bridge((message, socket) => {
      if (message.type !== "request" || message.method !== "process.run") return
      connections += 1
      socket.send(
        JSON.stringify({
          type: "response",
          version: RPC_VERSION,
          requestId: message.requestId,
          result: { streamId: `${message.requestId}:process`, command: "test", cwd: "." },
        }),
      )
      if (connections === 1) {
        socket.close()
        return
      }
      socket.send(
        JSON.stringify({
          type: "event",
          version: RPC_VERSION,
          streamId: `${message.requestId}:process`,
          seq: 0,
          event: "exit",
          data: { exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0, truncated: false },
        }),
      )
    })
    try {
      await expect(
        RemoteWorkerClient.runProcess(
          { rootId: "workspace", command: "test", cwd: "." },
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "REMOTE_DISCONNECTED", message: "Remote tool bridge disconnected" })

      const next = await RemoteWorkerClient.runProcess(
        { rootId: "workspace", command: "test", cwd: "." },
        new AbortController().signal,
        () => undefined,
      )
      expect(next.exit.exitCode).toBe(0)
      expect(connections).toBe(2)
    } finally {
      RemoteWorkerClient.dispose()
      await close(server)
    }
  })

  test("ignores a stale worker close after a new worker epoch is established", async () => {
    let connections = 0
    const server = await bridge((message, socket) => {
      if (message.type !== "request" || message.method !== "process.run") return
      connections += 1
      socket.send(
        JSON.stringify({
          type: "event",
          version: RPC_VERSION,
          streamId: "worker",
          seq: 0,
          event: "heartbeat",
          workerEpoch: connections === 1 ? "old" : "new",
          data: {},
        }),
      )
      if (connections === 2) {
        socket.send(
          JSON.stringify({
            type: "event",
            version: RPC_VERSION,
            streamId: "worker",
            seq: 1,
            event: "closed",
            workerEpoch: "old",
            data: { code: "REMOTE_DISCONNECTED", message: "stale worker closed" },
          }),
        )
      }
      socket.send(
        JSON.stringify({
          type: "response",
          version: RPC_VERSION,
          requestId: message.requestId,
          result: { streamId: `${message.requestId}:process`, command: "test", cwd: "." },
        }),
      )
      if (connections === 1) {
        socket.close()
        return
      }
      socket.send(
        JSON.stringify({
          type: "event",
          version: RPC_VERSION,
          streamId: `${message.requestId}:process`,
          seq: 0,
          event: "exit",
          workerEpoch: "new",
          data: { exitCode: 0, signal: null, stdoutBytes: 0, stderrBytes: 0, truncated: false },
        }),
      )
    })
    try {
      await expect(
        RemoteWorkerClient.runProcess(
          { rootId: "workspace", command: "test", cwd: "." },
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "REMOTE_DISCONNECTED" })

      const next = await RemoteWorkerClient.runProcess(
        { rootId: "workspace", command: "test", cwd: "." },
        new AbortController().signal,
        () => undefined,
      )
      expect(next.exit.exitCode).toBe(0)
      expect(connections).toBe(2)
    } finally {
      RemoteWorkerClient.dispose()
      await close(server)
    }
  })
})

async function bridge(
  onMessage: (message: RpcMessage, socket: import("ws").WebSocket) => void,
): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  const listening = deferred<void>()
  server.once("listening", () => listening.resolve())
  server.on("connection", (socket) => {
    socket.on("message", (data) => onMessage(JSON.parse(data.toString()) as RpcMessage, socket))
  })
  await listening.promise
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("WebSocket test bridge did not bind")
  process.env.KILO_REMOTE_TOOL_HOST = "1"
  process.env.KILO_REMOTE_BRIDGE_URL = `ws://127.0.0.1:${address.port}`
  process.env.KILO_REMOTE_BRIDGE_TOKEN = "test-token"
  return server
}

async function close(server: WebSocketServer) {
  for (const client of server.clients) client.terminate()
  server.close()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
