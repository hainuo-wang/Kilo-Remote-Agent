import { createHash } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import type {
  FileResult,
  GrepResult,
  HelloResult,
  ListResult,
  PtyAccepted,
  ProcessAccepted,
  ProcessExit,
  RpcCancel,
  RpcEvent,
  RpcRequest,
  RpcResponse,
  StatResult,
  WriteResult,
} from "@kilocode/kilo-remote-protocol"
import {
  isControllerCredentialEnvironmentKey,
  isRpcMessage,
  RPC_VERSION,
  rpcError,
} from "@kilocode/kilo-remote-protocol"
import { Shell } from "@opencode-ai/core/shell"
import type { Proc } from "@opencode-ai/core/pty/driver"
import { KiloPtyTermination } from "@opencode-ai/core/kilocode/pty/termination"

type WorkerOptions = {
  root: string
}

type ActiveProcess = {
  child: ChildProcess
  streamId: string
}

type ActivePty = {
  proc: Proc
  streamId: string
  requestId: string
}

const MAX_GREP_RESULTS = 1_000
const MAX_LIST_RESULTS = 10_000
const BATCH_SIZE = 32 * 1024

export async function runRemoteWorker(options: WorkerOptions): Promise<void> {
  const root = await realpath(resolve(options.root))
  const active = new Map<string, ActiveProcess>()
  const ptys = new Map<string, ActivePty>()
  const cancelled = new Set<string>()
  const inFlight = new Set<string>()
  let writeQueue = Promise.resolve()

  const send = (message: RpcResponse | RpcEvent) => {
    writeQueue = writeQueue.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          const line = JSON.stringify(message) + "\n"
          if (process.stdout.write(line, "utf8")) {
            resolveWrite()
            return
          }
          process.stdout.once("drain", resolveWrite)
          process.stdout.once("error", rejectWrite)
        }),
    )
    return writeQueue
  }

  const response = (requestId: string, result?: unknown, error?: ReturnType<typeof rpcError>) =>
    send({
      type: "response",
      version: RPC_VERSION,
      requestId,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    })

  const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  process.stdin.setEncoding("utf8")
  const pending = new Set<Promise<void>>()

  for await (const line of lineReader) {
    if (!line.trim()) continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      await send({
        type: "event",
        version: RPC_VERSION,
        streamId: "worker",
        seq: 0,
        event: "error",
        data: rpcError("INVALID_REQUEST", "Input is not valid JSON"),
      })
      continue
    }

    if (!isRpcMessage(message)) {
      await send({
        type: "event",
        version: RPC_VERSION,
        streamId: "worker",
        seq: 0,
        event: "error",
        data: rpcError("INVALID_REQUEST", "Input is not a supported RPC message"),
      })
      continue
    }

    if (message.type === "cancel") {
      await cancel(message, active, ptys, cancelled, inFlight)
      continue
    }

    if (message.type !== "request") continue
    inFlight.add(message.requestId)
    const task = handleRequest(message, { root, active, ptys, cancelled, send, response })
      .catch(async (error) => {
        await response(message.requestId, undefined, rpcError("INTERNAL", errorMessage(error)))
      })
      .finally(() => {
        inFlight.delete(message.requestId)
        cancelled.delete(message.requestId)
      })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  for (const process of active.values()) terminate(process.child)
  await Promise.all([...ptys.values()].map((pty) => KiloPtyTermination.terminate(pty.proc).catch(() => undefined)))
  await Promise.all(pending)
}

async function handleRequest(
  request: RpcRequest,
  context: {
    root: string
    active: Map<string, ActiveProcess>
    ptys: Map<string, ActivePty>
    cancelled: Set<string>
    send: (message: RpcResponse | RpcEvent) => Promise<void>
    response: (requestId: string, result?: unknown, error?: ReturnType<typeof rpcError>) => Promise<void>
  },
) {
  try {
    switch (request.method) {
      case "system.hello":
        await context.response(request.requestId, hello(context.root))
        return
      case "fs.readFile":
        await context.response(request.requestId, await readFileRequest(context.root, request.params))
        return
      case "fs.writeFile":
        await context.response(request.requestId, await writeFileRequest(context.root, request.params))
        return
      case "fs.editFile":
        await context.response(request.requestId, await editFileRequest(context.root, request.params))
        return
      case "fs.listFiles":
        await context.response(request.requestId, await listFilesRequest(context.root, request.params))
        return
      case "fs.stat":
        await context.response(request.requestId, await statRequest(context.root, request.params))
        return
      case "search.grep":
        await context.response(request.requestId, await grepRequest(context.root, request.params))
        return
      case "process.run":
        await runProcessRequest(request, context)
        return
      case "pty.start":
        await startPtyRequest(request, context)
        return
      case "pty.input":
        await ptyInputRequest(request, context)
        return
      case "pty.resize":
        await ptyResizeRequest(request, context)
        return
      case "pty.close":
        await ptyCloseRequest(request, context)
        return
      default:
        await context.response(
          request.requestId,
          undefined,
          rpcError("UNKNOWN_METHOD", `Unknown method: ${request.method}`),
        )
    }
  } catch (error) {
    await context.response(request.requestId, undefined, toRpcError(error))
  }
}

function hello(root: string): HelloResult {
  return {
    protocol: { major: 1, minor: 0 },
    worker: {
      pid: process.pid,
      platform: process.platform,
      cwd: root,
    },
    capabilities: [
      "system.hello",
      "fs.readFile",
      "fs.writeFile",
      "fs.editFile",
      "fs.listFiles",
      "fs.stat",
      "search.grep",
      "process.run",
      "pty.start",
      "pty.input",
      "pty.resize",
      "pty.close",
    ],
    roots: [{ rootId: "workspace", relative: "." }],
  }
}

async function readFileRequest(root: string, params: unknown): Promise<FileResult> {
  const input = objectParams(params)
  assertRoot(input)
  const path = await safePath(root, input.path)
  const content = await readFile(path)
  return {
    encoding: "base64",
    content: content.toString("base64"),
    sha256: sha256(content),
    bytes: content.byteLength,
  }
}

async function writeFileRequest(root: string, params: unknown): Promise<WriteResult> {
  const input = objectParams(params)
  assertRoot(input)
  const path = await safePath(root, input.path, true)
  const content = decodeContent(input.content)
  await checkExpectedSha(path, input.expectedSha256)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return { path: relative(root, path), sha256: sha256(content), bytes: content.byteLength }
}

async function editFileRequest(root: string, params: unknown): Promise<WriteResult> {
  const input = objectParams(params)
  assertRoot(input)
  const path = await safePath(root, input.path)
  const current = await readFile(path, "utf8")
  await checkExpectedSha(path, input.expectedSha256, Buffer.from(current))
  if (typeof input.oldString !== "string" || typeof input.newString !== "string") {
    throw new WorkerError("INVALID_REQUEST", "fs.editFile requires oldString and newString")
  }
  const replaceAll = input.replaceAll === true
  const occurrences = current.split(input.oldString).length - 1
  if (occurrences === 0) throw new WorkerError("CONFLICT", "oldString was not found in the file")
  if (!replaceAll && occurrences > 1) {
    throw new WorkerError("CONFLICT", "oldString matched more than once; set replaceAll to edit all matches")
  }
  const next = replaceAll
    ? current.split(input.oldString).join(input.newString)
    : current.replace(input.oldString, input.newString)
  const content = Buffer.from(next)
  await writeFile(path, content)
  return { path: relative(root, path), sha256: sha256(content), bytes: content.byteLength }
}

async function listFilesRequest(root: string, params: unknown): Promise<ListResult> {
  const input = objectParams(params)
  assertRoot(input)
  const base = await safePath(root, input.path ?? ".")
  const recursive = input.recursive === true
  const limit = positiveInteger(input.limit, MAX_LIST_RESULTS)
  const entries: Array<{ path: string; type: "file" | "directory" }> = []

  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entries.length >= limit) return
      const absolute = resolve(directory, entry.name)
      const relativePath = relative(root, absolute).split(sep).join("/")
      if (entry.isDirectory()) {
        entries.push({ path: `${relativePath}/`, type: "directory" })
        if (recursive) await visit(absolute)
      } else if (entry.isFile()) {
        entries.push({ path: relativePath, type: "file" })
      }
    }
  }

  const info = await stat(base)
  if (info.isFile()) {
    return { entries: [{ path: relative(root, base).split(sep).join("/"), type: "file" }] }
  }
  await visit(base)
  return { entries }
}

async function statRequest(root: string, params: unknown): Promise<StatResult> {
  const input = objectParams(params)
  assertRoot(input)
  const absolute = await safePath(root, input.path)
  const info = await stat(absolute)
  const type = info.isFile() ? "file" : info.isDirectory() ? "directory" : undefined
  if (!type) throw new WorkerError("INVALID_REQUEST", "path is not a regular file or directory")
  return {
    path: relative(root, absolute).split(sep).join("/") || ".",
    type,
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  }
}

async function grepRequest(root: string, params: unknown): Promise<GrepResult> {
  const input = objectParams(params)
  assertRoot(input)
  if (typeof input.pattern !== "string") throw new WorkerError("INVALID_REQUEST", "search.grep requires pattern")
  const expression = new RegExp(input.pattern, typeof input.flags === "string" ? input.flags : "")
  const base = await safePath(root, input.path ?? ".")
  const include = typeof input.include === "string" ? new RegExp(globToRegex(input.include)) : undefined
  const limit = positiveInteger(input.limit, MAX_GREP_RESULTS)
  const matches: Array<GrepResult["matches"][number]> = []
  let truncated = false

  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (matches.length >= limit) {
        truncated = true
        return
      }
      const absolute = resolve(directory, entry.name)
      const relativePath = relative(root, absolute).split(sep).join("/")
      if (entry.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (include) {
        include.lastIndex = 0
        const matchesRelativePath = include.test(relativePath)
        include.lastIndex = 0
        if (!matchesRelativePath && !include.test(entry.name)) continue
      }
      const content = await readFile(absolute)
      if (content.includes(0)) continue
      const lines = content.toString("utf8").split(/\r?\n/)
      for (let index = 0; index < lines.length; index++) {
        expression.lastIndex = 0
        const match = expression.exec(lines[index]!)
        if (!match) continue
        matches.push({ path: relativePath, line: index + 1, column: match.index + 1, text: lines[index]! })
        if (matches.length >= limit) {
          truncated = true
          return
        }
      }
    }
  }

  const info = await stat(base)
  if (info.isDirectory()) await visit(base)
  else {
    const content = await readFile(base)
    if (!content.includes(0)) {
      const relativePath = relative(root, base).split(sep).join("/")
      for (const [index, line] of content.toString("utf8").split(/\r?\n/).entries()) {
        if (matches.length >= limit) {
          truncated = true
          break
        }
        expression.lastIndex = 0
        const match = expression.exec(line)
        if (match) matches.push({ path: relativePath, line: index + 1, column: match.index + 1, text: line })
      }
    }
  }
  return { matches, truncated }
}

async function runProcessRequest(
  request: RpcRequest,
  context: {
    root: string
    active: Map<string, ActiveProcess>
    cancelled: Set<string>
    send: (message: RpcResponse | RpcEvent) => Promise<void>
    response: (requestId: string, result?: unknown, error?: ReturnType<typeof rpcError>) => Promise<void>
  },
) {
  const input = objectParams(request.params)
  assertRoot(input)
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new WorkerError("INVALID_REQUEST", "process.run requires a command")
  }
  const cwd = await safePath(context.root, input.cwd ?? ".")
  const info = await stat(cwd)
  if (!info.isDirectory()) throw new WorkerError("INVALID_REQUEST", "process.run cwd must be a directory")
  if (context.cancelled.delete(request.requestId)) {
    throw new WorkerError("CANCELLED", "process.run was cancelled before it started")
  }

  const streamId = `${request.requestId}:process`
  const child = spawn(input.command, {
    cwd,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: remoteProcessEnvironment(),
    windowsHide: true,
  })
  child.stdin?.end()
  const running = { child, streamId }
  context.active.set(request.requestId, running)
  let sequence = 0
  let stdoutBytes = 0
  let stderrBytes = 0
  let settled = false
  let outputQueue = Promise.resolve()
  let resolveDone!: () => void
  const done = new Promise<void>((resolveDonePromise) => {
    resolveDone = resolveDonePromise
  })

  const enqueue = (task: () => Promise<void>) => {
    outputQueue = outputQueue.catch(() => undefined).then(task)
    return outputQueue
  }
  const sendEvent = (event: RpcEvent["event"], data: unknown) =>
    context.send({
      type: "event",
      version: RPC_VERSION,
      streamId,
      seq: sequence++,
      event,
      data,
    })
  const emit = (event: RpcEvent["event"], data: unknown) => enqueue(() => sendEvent(event, data))
  const emitOutput = async (event: "stdout" | "stderr", chunk: Buffer) => {
    if (event === "stdout") stdoutBytes += chunk.byteLength
    else stderrBytes += chunk.byteLength
    for (let offset = 0; offset < chunk.byteLength; offset += BATCH_SIZE) {
      await sendEvent(event, {
        encoding: "base64",
        chunk: chunk.subarray(offset, offset + BATCH_SIZE).toString("base64"),
      })
    }
  }

  const queueOutput = (event: "stdout" | "stderr", chunk: Buffer) => {
    void enqueue(async () => emitOutput(event, chunk))
  }
  child.stdout?.on("data", (chunk: Buffer) => queueOutput("stdout", Buffer.from(chunk)))
  child.stderr?.on("data", (chunk: Buffer) => queueOutput("stderr", Buffer.from(chunk)))
  child.once("error", (error) => {
    if (settled) return
    settled = true
    context.active.delete(request.requestId)
    void emit("error", rpcError("PROCESS_FAILED", error.message)).finally(resolveDone)
  })
  child.once("close", (exitCode, signal) => {
    if (settled) return
    settled = true
    context.active.delete(request.requestId)
    void (async () => {
      await outputQueue
      const exit: ProcessExit = {
        exitCode,
        signal,
        stdoutBytes,
        stderrBytes,
        truncated: false,
      }
      await emit("exit", exit)
    })()
      .catch(() => undefined)
      .finally(resolveDone)
  })

  const timeoutMs =
    input.timeoutMs !== undefined
      ? positiveInteger(input.timeoutMs, 0)
      : request.deadline === undefined
        ? 0
        : Math.max(0, request.deadline - Date.now())
  const timeout =
    request.deadline !== undefined || timeoutMs > 0
      ? setTimeout(() => {
          if (!settled) {
            void emit("error", rpcError("TIMEOUT", `Process exceeded ${timeoutMs}ms`))
            terminate(child)
          }
        }, timeoutMs)
      : undefined
  child.once("close", () => {
    if (timeout) clearTimeout(timeout)
  })

  const accepted: ProcessAccepted = { streamId, command: input.command, cwd: relative(context.root, cwd) || "." }
  await context.response(request.requestId, accepted)
  await done
}

async function startPtyRequest(
  request: RpcRequest,
  context: {
    root: string
    ptys: Map<string, ActivePty>
    cancelled: Set<string>
    send: (message: RpcResponse | RpcEvent) => Promise<void>
    response: (requestId: string, result?: unknown, error?: ReturnType<typeof rpcError>) => Promise<void>
  },
) {
  const input = objectParams(request.params)
  assertRoot(input)
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new WorkerError("INVALID_REQUEST", "pty.start requires command")
  }

  const cwd = await safePath(context.root, input.cwd ?? ".")
  const shell = typeof input.shell === "string" && input.shell.length > 0 ? input.shell : Shell.preferred()
  const cols = positiveInteger(input.cols, 100)
  const rows = positiveInteger(input.rows, 24)
  if (context.cancelled.delete(request.requestId)) {
    throw new WorkerError("CANCELLED", "pty.start was cancelled before it started")
  }
  const args = Shell.args(shell, input.command, cwd)
  const { spawn } = await import("@opencode-ai/core/pty/driver")
  const proc = spawn(shell, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: remoteProcessEnvironment(),
  })
  const streamId = `${request.requestId}:pty`
  const state: ActivePty = { proc, streamId, requestId: request.requestId }
  context.ptys.set(streamId, state)

  let sequence = 0
  let stdoutBytes = 0
  let finished = false
  let outputQueue = Promise.resolve()
  const done = Promise.withResolvers<void>()
  const emit = (event: RpcEvent["event"], data: unknown) => {
    const message: RpcEvent = {
      type: "event",
      version: RPC_VERSION,
      streamId,
      seq: sequence++,
      event,
      data,
    }
    outputQueue = outputQueue.then(() => context.send(message))
    return outputQueue
  }

  const finish = (exitCode: number | null, signal: string | null) => {
    if (finished) return
    finished = true
    context.ptys.delete(streamId)
    void outputQueue
      .then(() =>
        emit("exit", {
          exitCode,
          signal,
          stdoutBytes,
          stderrBytes: 0,
          truncated: false,
        } satisfies ProcessExit),
      )
      .catch(() => undefined)
      .finally(() => done.resolve())
  }

  proc.onData((data) => {
    const chunk = Buffer.from(data, "utf8")
    stdoutBytes += chunk.byteLength
    void emit("stdout", { encoding: "base64", chunk: chunk.toString("base64") }).catch(() => undefined)
  })
  proc.onExit((event) => {
    const signal = event.signal === undefined ? null : String(event.signal)
    finish(event.exitCode, signal)
  })

  const accepted: PtyAccepted = {
    streamId,
    pid: proc.pid,
    shell,
    cwd: relative(context.root, cwd) || ".",
    cols,
    rows,
  }
  await context.response(request.requestId, accepted)
  await done.promise
}

async function ptyInputRequest(
  request: RpcRequest,
  context: {
    ptys: Map<string, ActivePty>
    response: (requestId: string, result?: unknown, error?: ReturnType<typeof rpcError>) => Promise<void>
  },
) {
  const input = objectParams(request.params)
  const streamId = requiredString(input.streamId, "pty.input requires streamId")
  const active = context.ptys.get(streamId)
  if (!active) throw new WorkerError("PTY_NOT_FOUND", `PTY stream not found: ${streamId}`)
  const data = decodeContent({ encoding: "base64", data: input.data })
  active.proc.write(data.toString("utf8"))
  await context.response(request.requestId, {})
}

async function ptyResizeRequest(
  request: RpcRequest,
  context: {
    ptys: Map<string, ActivePty>
    response: (requestId: string, result?: unknown, error?: ReturnType<typeof rpcError>) => Promise<void>
  },
) {
  const input = objectParams(request.params)
  const streamId = requiredString(input.streamId, "pty.resize requires streamId")
  const active = context.ptys.get(streamId)
  if (!active) throw new WorkerError("PTY_NOT_FOUND", `PTY stream not found: ${streamId}`)
  const cols = positiveInteger(input.cols, 1)
  const rows = positiveInteger(input.rows, 1)
  active.proc.resize(cols, rows)
  await context.response(request.requestId, {})
}

async function ptyCloseRequest(
  request: RpcRequest,
  context: {
    ptys: Map<string, ActivePty>
    response: (requestId: string, result?: unknown, error?: ReturnType<typeof rpcError>) => Promise<void>
  },
) {
  const input = objectParams(request.params)
  const streamId = requiredString(input.streamId, "pty.close requires streamId")
  const active = context.ptys.get(streamId)
  if (!active) throw new WorkerError("PTY_NOT_FOUND", `PTY stream not found: ${streamId}`)
  await KiloPtyTermination.terminate(active.proc)
  await context.response(request.requestId, {})
}

async function cancel(
  message: RpcCancel,
  active: Map<string, ActiveProcess>,
  ptys: Map<string, ActivePty>,
  cancelled: Set<string>,
  inFlight: Set<string>,
) {
  const process = active.get(message.requestId)
  if (process) {
    terminate(process.child)
    return
  }
  const streamId = message.streamId ?? `${message.requestId}:pty`
  const pty = ptys.get(streamId)
  if (pty) await KiloPtyTermination.terminate(pty.proc).catch(() => undefined)
  else if (inFlight.has(message.requestId)) cancelled.add(message.requestId)
}

function terminate(child: ChildProcess) {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill()
    else process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill()
  }
}

function remoteProcessEnvironment(): Record<string, string> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (isControllerCredentialEnvironmentKey(key)) delete env[key]
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

async function safePath(root: string, input: unknown, allowMissing = false): Promise<string> {
  if (typeof input !== "string" || input.length === 0)
    throw new WorkerError("INVALID_REQUEST", "path must be a non-empty string")
  if (input.includes("\0")) throw new WorkerError("INVALID_REQUEST", "path contains a NUL byte")
  const candidate = resolve(root, input)
  if (!isInside(root, candidate)) throw new WorkerError("OUTSIDE_WORKSPACE", "path escapes the workspace root")
  try {
    const target = await realpath(candidate)
    if (!isInside(root, target)) throw new WorkerError("OUTSIDE_WORKSPACE", "path resolves outside the workspace root")
    return target
  } catch (error) {
    if (!allowMissing || !isMissing(error)) throw error
    const parent = await findExistingParent(root, dirname(candidate))
    return resolve(parent, candidate.slice(parent.length + 1))
  }
}

async function findExistingParent(root: string, path: string): Promise<string> {
  let current = path
  while (isInside(root, current)) {
    try {
      const parent = await realpath(current)
      if (!isInside(root, parent))
        throw new WorkerError("OUTSIDE_WORKSPACE", "parent resolves outside the workspace root")
      return parent
    } catch (error) {
      if (!isMissing(error)) throw error
      const next = dirname(current)
      if (next === current) break
      current = next
    }
  }
  throw new WorkerError("OUTSIDE_WORKSPACE", "could not resolve a workspace parent")
}

function isInside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function checkExpectedSha(path: string, expected: unknown, current?: Buffer) {
  if (expected === undefined) return
  const actual = current ?? (await readFile(path))
  if (sha256(actual) !== expected) throw new WorkerError("CONFLICT", "file changed since the request was created")
}

function decodeContent(input: unknown): Buffer {
  if (!input || typeof input !== "object") throw new WorkerError("INVALID_REQUEST", "content must be an encoded object")
  const content = input as Record<string, unknown>
  if (content.encoding !== "base64" || typeof content.data !== "string") {
    throw new WorkerError("INVALID_REQUEST", "content must use base64 encoding")
  }
  return Buffer.from(content.data, "base64")
}

function objectParams(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkerError("INVALID_REQUEST", "params must be an object")
  }
  return input as Record<string, unknown>
}

function requiredString(input: unknown, message: string): string {
  if (typeof input !== "string" || input.length === 0) throw new WorkerError("INVALID_REQUEST", message)
  return input
}

function assertRoot(input: Record<string, unknown>) {
  if (input.rootId !== "workspace") throw new WorkerError("UNKNOWN_ROOT", "rootId must be workspace")
}

function positiveInteger(input: unknown, fallback: number) {
  return typeof input === "number" && Number.isInteger(input) && input > 0 ? input : fallback
}

function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

function globToRegex(pattern: string) {
  return `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")}$`
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function toRpcError(error: unknown) {
  if (error instanceof WorkerError) return rpcError(error.code, error.message)
  if (isMissing(error)) return rpcError("NOT_FOUND", errorMessage(error))
  if (error && typeof error === "object" && "code" in error && error.code === "EACCES") {
    return rpcError("PERMISSION_DENIED", errorMessage(error))
  }
  return rpcError("INTERNAL", errorMessage(error))
}

class WorkerError extends Error {
  constructor(
    readonly code: Parameters<typeof rpcError>[0],
    message: string,
  ) {
    super(message)
  }
}
