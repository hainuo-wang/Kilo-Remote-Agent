import * as vscode from "vscode"
import type { RpcEvent, RpcRequest, RpcResponse } from "@kilocode/kilo-remote-protocol"
import { REMOTE_COMMANDS, RPC_VERSION } from "@kilocode/kilo-remote-protocol"
import { ControllerBridge, HTTP_CANCEL_COMMAND, HTTP_COMMAND } from "./bridge-server"
import { configureMioffice } from "./mioffice"

const SMOKE_COMMAND = "kilo-code.new.remote.runSmoke"
const REQUEST_TIMEOUT_MS = 30_000
const STREAM_TIMEOUT_MS = 60_000

type RemoteEvent = RpcEvent & { workerEpoch?: string }

type PendingStream = {
  events: RpcEvent[]
  resolve: () => void
}

const streams = new Map<string, PendingStream>()
let bridge: ControllerBridge | undefined

export function activate(context: vscode.ExtensionContext) {
  console.log(`[Kilo Remote Controller] activated host=${process.platform} remote=${vscode.env.remoteName ?? "local"}`)
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.remote.configureMioffice", () => configureMioffice(context)),
  )
  if (
    !vscode.env.remoteName?.startsWith("ssh-remote") ||
    !vscode.workspace.getConfiguration("kilo-code.new.experimental").get("cursorLikeRemote", false)
  ) {
    return
  }

  bridge = new ControllerBridge(context)
  context.subscriptions.push(bridge)
  context.subscriptions.push(
    vscode.commands.registerCommand(REMOTE_COMMANDS.controllerEvent, async (event: RemoteEvent) => {
      await bridge?.forward(event)
      if (event.event === "closed" && event.streamId === "worker") {
        for (const stream of streams.values()) {
          stream.events.push(event)
          stream.resolve()
        }
        return
      }
      const stream = streams.get(event.streamId)
      if (!stream) return
      stream.events.push(event)
      if (event.event === "exit" || event.event === "error" || event.event === "closed") stream.resolve()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand(HTTP_COMMAND, (request) => bridge?.http(request)),
    vscode.commands.registerCommand(HTTP_CANCEL_COMMAND, (request: { requestId: string }) =>
      bridge?.cancelHttp(request.requestId),
    ),
    vscode.commands.registerCommand(REMOTE_COMMANDS.controllerPtyCreate, (request) => bridge?.ptyCreate(request)),
    vscode.commands.registerCommand(REMOTE_COMMANDS.controllerPtyResize, (request) => bridge?.ptyResize(request)),
    vscode.commands.registerCommand(REMOTE_COMMANDS.controllerPtyClose, (request) => bridge?.ptyClose(request)),
  )
  context.subscriptions.push(vscode.commands.registerCommand(SMOKE_COMMAND, runSmoke))
}

async function request(request: Omit<RpcRequest, "version">): Promise<RpcResponse> {
  return withTimeout(
    vscode.commands.executeCommand(REMOTE_COMMANDS.request, {
      ...request,
      version: RPC_VERSION,
    }),
    REQUEST_TIMEOUT_MS,
    `Remote request timed out: ${request.method}`,
  )
}

async function runSmoke() {
  const hello = await request({
    type: "request",
    requestId: crypto.randomUUID(),
    method: "system.hello",
    params: {},
  })
  if (hello.error) throw new Error(`${hello.error.code}: ${hello.error.message}`)

  const filePath = `.kilo-remote-smoke-${crypto.randomUUID()}.txt`
  const content = "kilo remote smoke\n"
  let created = false
  try {
    const written = await request({
      type: "request",
      requestId: crypto.randomUUID(),
      method: "fs.writeFile",
      params: {
        rootId: "workspace",
        path: filePath,
        content: { encoding: "base64", data: Buffer.from(content).toString("base64") },
      },
    })
    if (written.error) throw new Error(`${written.error.code}: ${written.error.message}`)
    created = true

    const read = await request({
      type: "request",
      requestId: crypto.randomUUID(),
      method: "fs.readFile",
      params: { rootId: "workspace", path: filePath },
    })
    if (read.error) throw new Error(`${read.error.code}: ${read.error.message}`)
    const readResult = read.result as { content?: string }
    if (Buffer.from(readResult.content ?? "", "base64").toString("utf8") !== content) {
      throw new Error("Remote read did not return the content written by the worker")
    }

    const listed = await request({
      type: "request",
      requestId: crypto.randomUUID(),
      method: "fs.listFiles",
      params: { rootId: "workspace", path: ".", recursive: false, limit: 10_000 },
    })
    if (listed.error) throw new Error(`${listed.error.code}: ${listed.error.message}`)
    const entries = (listed.result as { entries?: Array<{ path: string }> }).entries ?? []
    if (!entries.some((entry) => entry.path === filePath)) throw new Error("Remote list did not include the smoke file")

    const grep = await request({
      type: "request",
      requestId: crypto.randomUUID(),
      method: "search.grep",
      params: { rootId: "workspace", path: ".", pattern: "kilo remote smoke", include: filePath },
    })
    if (grep.error) throw new Error(`${grep.error.code}: ${grep.error.message}`)
    const matches = (grep.result as { matches?: unknown[] }).matches ?? []
    if (matches.length !== 1) throw new Error(`Remote grep returned ${matches.length} matches instead of one`)

    const process = await runRemoteProcess(
      `printf 'stdout\\n'; printf 'stderr\\n' >&2; pwd; uname -a; ` +
        `if env | grep -Eiq '(^|_)(MIOFFICE|OPENAI|ANTHROPIC)(_|$)'; then ` +
        `printf 'controller credential leaked to remote process\\n' >&2; exit 42; fi; ` +
        `git diff --no-ext-diff --stat >/dev/null 2>&1 || true; cat ${shellQuote(filePath)}`,
    )
    const output = process.output
    const exit = process.exit
    if (exit.exitCode !== 0) throw new Error(`Remote smoke process exited with ${exit.exitCode ?? "unknown"}`)
    if (
      !output.stdout.includes("stdout") ||
      !output.stderr.includes("stderr") ||
      !output.stdout.includes(content.trim())
    ) {
      throw new Error("Remote process output was incomplete")
    }

    const helloResult =
      hello.result && typeof hello.result === "object" && "worker" in hello.result
        ? (hello.result as { worker: { platform: string; cwd?: string } })
        : undefined
    void vscode.window.showInformationMessage(
      `Remote worker ${helloResult?.worker.platform ?? "unknown"} passed read/write/list/grep/process smoke in ${
        helloResult?.worker.cwd ?? "unknown"
      }.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    )
  } finally {
    if (created) await runRemoteProcess(`rm -f ${shellQuote(filePath)}`).catch(() => undefined)
  }
}

async function runRemoteProcess(command: string, cwd = ".") {
  const requestId = crypto.randomUUID()
  const streamId = `${requestId}:process`
  const stream = new Promise<PendingStream>((resolve) => {
    const value: PendingStream = {
      events: [],
      resolve: () => resolve(value),
    }
    streams.set(streamId, value)
  })
  try {
    const accepted = await request({
      type: "request",
      requestId,
      method: "process.run",
      params: { rootId: "workspace", command, cwd },
    })
    if (accepted.error) throw new Error(`${accepted.error.code}: ${accepted.error.message}`)
    const result = await withTimeout(stream, STREAM_TIMEOUT_MS, "Remote process stream timed out")
    const stdout = Buffer.concat(
      result.events.filter((event) => event.event === "stdout").map((event) => decodeChunk(event)),
    ).toString("utf8")
    const stderr = Buffer.concat(
      result.events.filter((event) => event.event === "stderr").map((event) => decodeChunk(event)),
    ).toString("utf8")
    const exit = result.events.find((event) => event.event === "exit")?.data as
      | { exitCode?: number | null; stdoutBytes?: number; stderrBytes?: number }
      | undefined
    if (!exit) throw new Error("Remote process ended without an exit event")
    const stdoutBytes = Buffer.byteLength(stdout)
    const stderrBytes = Buffer.byteLength(stderr)
    if (stdoutBytes !== (exit.stdoutBytes ?? -1) || stderrBytes !== (exit.stderrBytes ?? -1)) {
      throw new Error(
        `Remote output was incomplete: stdout ${stdoutBytes}/${exit.stdoutBytes ?? "unknown"}, stderr ${stderrBytes}/${exit.stderrBytes ?? "unknown"}`,
      )
    }
    return { output: { stdout, stderr }, exit }
  } finally {
    streams.delete(streamId)
  }
}

function decodeChunk(event: RpcEvent): Buffer {
  const data = event.data as { encoding?: string; chunk?: string }
  if (data.encoding !== "base64") throw new Error("Remote process returned a non-base64 output chunk")
  return Buffer.from(data.chunk ?? "", "base64")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function deactivate() {
  bridge?.dispose()
  bridge = undefined
  streams.clear()
}

async function withTimeout<T>(promise: Thenable<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
