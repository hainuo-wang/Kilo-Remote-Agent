export const RPC_VERSION = 1

export const REMOTE_COMMANDS = {
  request: "kilo-code.new.internal.remote.request",
  cancel: "kilo-code.new.internal.remote.cancel",
  controllerEvent: "kilo-code.new.internal.controller.event",
  controllerHttp: "kilo-code.new.internal.controller.http",
  controllerHttpCancel: "kilo-code.new.internal.controller.http.cancel",
  controllerHttpEvent: "kilo-code.new.internal.controller.http.event",
  controllerPtyCreate: "kilo-code.new.internal.controller.pty.create",
  controllerPtyResize: "kilo-code.new.internal.controller.pty.resize",
  controllerPtyClose: "kilo-code.new.internal.controller.pty.close",
} as const

const CONTROLLER_CREDENTIAL_ENVIRONMENT_KEY = /^(?:MIOFFICE|OPENAI|ANTHROPIC)(?:_|$)/i

export function isControllerCredentialEnvironmentKey(key: string): boolean {
  return (
    CONTROLLER_CREDENTIAL_ENVIRONMENT_KEY.test(key) ||
    /^(?:KILO_CONFIG_CONTENT|KILO_REMOTE_BRIDGE_URL|KILO_REMOTE_BRIDGE_TOKEN|KILO_SERVER_PASSWORD|KILO_API_KEY|KILO_AUTH_TOKEN|KILOCODE_API_KEY)$/i.test(
      key,
    )
  )
}

export type RpcError = {
  code:
    | "INVALID_REQUEST"
    | "UNKNOWN_METHOD"
    | "UNKNOWN_ROOT"
    | "OUTSIDE_WORKSPACE"
    | "NOT_FOUND"
    | "CONFLICT"
    | "PERMISSION_DENIED"
    | "PROCESS_FAILED"
    | "TIMEOUT"
    | "CANCELLED"
    | "REMOTE_DISCONNECTED"
    | "INTERNAL"
    | "PTY_NOT_FOUND"
  message: string
  details?: unknown
}

export type RpcRequest = {
  type: "request"
  version: typeof RPC_VERSION
  requestId: string
  method: string
  params?: unknown
  deadline?: number
}

export type RpcResponse = {
  type: "response"
  version: typeof RPC_VERSION
  requestId: string
  result?: unknown
  error?: RpcError
}

export type RpcEvent = {
  type: "event"
  version: typeof RPC_VERSION
  streamId: string
  seq: number
  event: "stdout" | "stderr" | "exit" | "error" | "closed" | "heartbeat"
  data: unknown
  workerEpoch?: string
}

export type RpcCancel = {
  type: "cancel"
  version: typeof RPC_VERSION
  requestId: string
  streamId?: string
}

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcCancel

const RPC_EVENTS = new Set<RpcEvent["event"]>(["stdout", "stderr", "exit", "error", "closed", "heartbeat"])

export type ControllerHttpRequest = {
  requestId: string
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

export type ControllerHttpResponse = {
  status: number
  statusText: string
  headers: Record<string, string>
  streamId?: string
}

export type ControllerHttpEvent =
  | {
      streamId: string
      event: "chunk"
      seq?: number
      data: { encoding: "base64"; chunk: string }
    }
  | {
      streamId: string
      event: "end"
      seq?: number
    }
  | {
      streamId: string
      event: "error"
      seq?: number
      error: { message: string }
    }

export type ControllerPtyCreateRequest = {
  cwd: string
  cols?: number
  rows?: number
  shell?: string
}

export type ControllerPtyCreateResponse = {
  streamId: string
  wsUrl: string
  pid: number
  cwd: string
}

export type ControllerPtyResizeRequest = {
  streamId: string
  cols: number
  rows: number
}

export type ControllerPtyCloseRequest = {
  streamId: string
}

export type HelloResult = {
  protocol: {
    major: number
    minor: number
  }
  worker: {
    pid: number
    platform: string
    cwd: string
  }
  capabilities: readonly string[]
  roots: readonly {
    rootId: string
    relative: string
  }[]
}

export type FileResult = {
  encoding: "base64"
  content: string
  sha256: string
  bytes: number
}

export type WriteResult = {
  path: string
  sha256: string
  bytes: number
}

export type ListResult = {
  entries: readonly {
    path: string
    type: "file" | "directory"
  }[]
}

export type StatResult = {
  path: string
  type: "file" | "directory"
  bytes: number
  mtimeMs: number
}

export type GrepResult = {
  matches: readonly {
    path: string
    line: number
    column: number
    text: string
  }[]
  truncated: boolean
}

export type ProcessAccepted = {
  streamId: string
  command: string
  cwd: string
}

export type PtyAccepted = {
  streamId: string
  pid: number
  shell: string
  cwd: string
  cols: number
  rows: number
}

export type ProcessExit = {
  exitCode: number | null
  signal: string | null
  stdoutBytes: number
  stderrBytes: number
  truncated: false
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Record<string, unknown>
  if (message.version !== RPC_VERSION || typeof message.type !== "string") return false
  if (message.type === "request") {
    return (
      typeof message.requestId === "string" &&
      message.requestId.length > 0 &&
      typeof message.method === "string" &&
      message.method.length > 0 &&
      (message.deadline === undefined || (typeof message.deadline === "number" && Number.isFinite(message.deadline)))
    )
  }
  if (message.type === "response") return typeof message.requestId === "string" && message.requestId.length > 0
  if (message.type === "event") {
    return (
      typeof message.streamId === "string" &&
      message.streamId.length > 0 &&
      typeof message.seq === "number" &&
      Number.isInteger(message.seq) &&
      message.seq >= 0 &&
      typeof message.event === "string" &&
      RPC_EVENTS.has(message.event as RpcEvent["event"])
    )
  }
  if (message.type === "cancel") {
    return (
      typeof message.requestId === "string" &&
      message.requestId.length > 0 &&
      (message.streamId === undefined || (typeof message.streamId === "string" && message.streamId.length > 0))
    )
  }
  return false
}

export function rpcError(code: RpcError["code"], message: string, details?: unknown): RpcError {
  return details === undefined ? { code, message } : { code, message, details }
}
