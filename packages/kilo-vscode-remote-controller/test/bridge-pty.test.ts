import { afterEach, describe, expect, mock, test } from "bun:test"
import { WebSocket } from "ws"
import type { RpcEvent, RpcRequest, RpcResponse } from "@kilocode/kilo-remote-protocol"

type CommandHandler = (command: string, argument?: unknown) => unknown

let commandHandler: CommandHandler = () => undefined

mock.module("vscode", () => ({
  commands: {
    executeCommand: (command: string, argument?: unknown) => commandHandler(command, argument),
  },
  env: {
    appName: "Kilo Test",
    isTelemetryEnabled: false,
    machineId: "kilo-test-machine",
    remoteName: "ssh-remote",
  },
  extensions: {
    getExtension: () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
    workspaceFile: undefined,
    workspaceFolders: undefined,
  },
}))

const { ControllerBridge } = await import("../src/bridge-server")

describe("controller PTY bridge", () => {
  let bridge: InstanceType<typeof ControllerBridge> | undefined

  afterEach(() => {
    bridge?.dispose()
    bridge = undefined
    commandHandler = () => undefined
  })

  test("creates an authenticated PTY and forwards input, output, resize, and close", async () => {
    const requests: RpcRequest[] = []
    commandHandler = (command, argument) => {
      if (command !== "kilo-code.new.internal.remote.request") return undefined
      const request = argument as RpcRequest
      requests.push(request)
      if (request.method === "pty.start") {
        return response(request, {
          streamId: `${request.requestId}:pty`,
          pid: 1234,
          shell: "/bin/bash",
          cwd: "/remote/project",
          cols: 80,
          rows: 24,
        })
      }
      return response(request)
    }

    bridge = new ControllerBridge(testContext())
    const environment = await bridge.env()
    const created = await bridge.ptyCreate({
      cwd: "/remote/project",
      cols: 100,
      rows: 30,
    })
    const url = new URL(created.wsUrl)

    expect(url.hostname).toBe("127.0.0.1")
    expect(url.pathname).toBe("/pty")
    expect(url.searchParams.get("token")).toBeTruthy()
    expect(url.searchParams.get("streamId")).toBe(created.streamId)
    expect(created.wsUrl.startsWith(`ws://127.0.0.1:${new URL(environment.KILO_REMOTE_BRIDGE_URL).port}`)).toBe(true)

    const socket = await connect(created.wsUrl)
    const output = nextMessage(socket)
    await bridge.forward(
      event(created.streamId, "stdout", { encoding: "base64", chunk: Buffer.from("hello").toString("base64") }),
    )
    expect(await output).toEqual(Buffer.from("hello"))

    socket.send(Buffer.from("input"))
    await waitFor(() => requests.some((request) => request.method === "pty.input"))
    const inputRequest = requests.find((request) => request.method === "pty.input")
    expect(inputRequest?.params).toEqual({
      streamId: created.streamId,
      data: Buffer.from("input").toString("base64"),
    })

    await bridge.ptyResize({ streamId: created.streamId, cols: 120, rows: 40 })
    const resizeRequest = requests.find((request) => request.method === "pty.resize")
    expect(resizeRequest?.params).toEqual({
      streamId: created.streamId,
      cols: 120,
      rows: 40,
    })

    const closed = waitForClose(socket, 1000)
    await bridge.ptyClose({ streamId: created.streamId })
    const closeRequest = requests.find((request) => request.method === "pty.close")
    expect(closeRequest?.params).toEqual({ streamId: created.streamId })
    await closed
  })

  test("rejects unauthorized sockets and drains output before closing on exit", async () => {
    commandHandler = (command, argument) => {
      if (command !== "kilo-code.new.internal.remote.request") return undefined
      const request = argument as RpcRequest
      return response(request, {
        streamId: `${request.requestId}:pty`,
        pid: 4321,
        shell: "/bin/bash",
        cwd: "/remote/project",
        cols: 80,
        rows: 24,
      })
    }

    bridge = new ControllerBridge(testContext())
    const created = await bridge.ptyCreate({ cwd: "/remote/project" })
    const url = new URL(created.wsUrl)
    url.searchParams.set("token", "wrong-token")
    await connectAndWaitForClose(url.toString(), 1008)

    const socket = await connect(created.wsUrl)
    const output = nextMessage(socket)
    const closed = waitForClose(socket, 1000)
    await bridge.forward(
      event(created.streamId, "stdout", { encoding: "base64", chunk: Buffer.from("tail").toString("base64") }),
    )
    await bridge.forward(event(created.streamId, "exit", { exitCode: 0, signal: null }))

    expect(await output).toEqual(Buffer.from("tail"))
    await closed
  })

  test("closes active PTYs when the worker disconnects", async () => {
    commandHandler = (command, argument) => {
      if (command !== "kilo-code.new.internal.remote.request") return undefined
      const request = argument as RpcRequest
      return response(request, {
        streamId: `${request.requestId}:pty`,
        pid: 5678,
        shell: "/bin/bash",
        cwd: "/remote/project",
        cols: 80,
        rows: 24,
      })
    }

    bridge = new ControllerBridge(testContext())
    const created = await bridge.ptyCreate({ cwd: "/remote/project" })
    const socket = await connect(created.wsUrl)
    const closed = waitForClose(socket, 1000)

    await bridge.forward(event("worker", "closed", { code: "REMOTE_DISCONNECTED" }))
    await closed
  })
})

function testContext() {
  return {
    extensionPath: "/tmp/kilo-controller-test",
    extension: {
      packageJSON: {
        version: "test",
      },
    },
    globalStorageUri: {
      fsPath: "/tmp/kilo-controller-test-storage",
    },
  } as never
}

function response(request: RpcRequest, result?: unknown): RpcResponse {
  return {
    type: "response",
    version: request.version,
    requestId: request.requestId,
    ...(result === undefined ? {} : { result }),
  }
}

function event(streamId: string, eventName: RpcEvent["event"], data: unknown): RpcEvent {
  return {
    type: "event",
    version: 1,
    streamId,
    seq: 0,
    event: eventName,
    data,
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once("open", () => resolve(socket))
    socket.once("error", reject)
  })
}

function nextMessage(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)))
    socket.once("error", reject)
  })
}

function waitForClose(socket: WebSocket, expectedCode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code) => {
      try {
        expect(code).toBe(expectedCode)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.once("error", reject)
  })
}

function connectAndWaitForClose(url: string, expectedCode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once("close", (code) => {
      try {
        expect(code).toBe(expectedCode)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.once("error", (error) => {
      if (socket.readyState !== WebSocket.CLOSED) reject(error)
    })
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for controller command")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
