import * as vscode from "vscode"
import { existsSync } from "node:fs"
import path from "node:path"
import type { RpcEvent, RpcRequest, RpcResponse } from "@kilocode/kilo-remote-protocol"
import { REMOTE_COMMANDS, RPC_VERSION } from "@kilocode/kilo-remote-protocol"
import { WorkerProcess } from "./worker-process"

let worker: WorkerProcess | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let heartbeatSequence = 0

export function activate(context: vscode.ExtensionContext) {
  console.log(`[Kilo Remote Worker] activated host=${process.platform} remote=${vscode.env.remoteName ?? "local"}`)
  if (
    !vscode.env.remoteName?.startsWith("ssh-remote") ||
    !vscode.workspace.getConfiguration("kilo-code.new.experimental").get("cursorLikeRemote", false)
  ) {
    return
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!root) {
    console.warn("[Kilo Remote Worker] No workspace folder is open")
    return
  }
  console.log(`[Kilo Remote Worker] workspace root=${root}`)

  const cliPath = resolveCliPath(context)

  const forward = async (event: RpcEvent) => {
    await vscode.commands.executeCommand(REMOTE_COMMANDS.controllerEvent, {
      ...event,
      workerEpoch: worker?.workerEpoch,
    })
  }
  const disconnect = (error: Error) => {
    void forward({
      type: "event",
      version: RPC_VERSION,
      streamId: "worker",
      seq: 0,
      event: "closed",
      data: { code: "REMOTE_DISCONNECTED", message: error.message },
    }).catch(() => undefined)
  }

  worker = new WorkerProcess(cliPath, root, forward, disconnect)
  context.subscriptions.push(worker)
  const heartbeat = () =>
    void Promise.resolve(
      vscode.commands.executeCommand(REMOTE_COMMANDS.controllerEvent, {
        type: "event",
        version: RPC_VERSION,
        streamId: "worker",
        seq: heartbeatSequence++,
        event: "heartbeat",
        data: { root },
        workerEpoch: worker?.workerEpoch,
      } satisfies RpcEvent & { workerEpoch?: string }),
    ).catch(() => undefined)
  heartbeat()
  heartbeatTimer = setInterval(heartbeat, 5_000)
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(heartbeatTimer)))
  context.subscriptions.push(
    vscode.commands.registerCommand(REMOTE_COMMANDS.request, async (request: RpcRequest): Promise<RpcResponse> => {
      if (!worker) throw new Error("Remote worker is unavailable")
      return worker.request(request)
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand(REMOTE_COMMANDS.cancel, (request: { requestId: string; streamId?: string }) => {
      worker?.cancel(request.requestId, request.streamId)
    }),
  )
}

function resolveCliPath(context: vscode.ExtensionContext) {
  const configured = vscode.workspace.getConfiguration("kilo-code").get<string>("remoteWorker.cliPath")?.trim()
  if (configured) return configured
  if (process.env.KILO_REMOTE_WORKER_CLI) return process.env.KILO_REMOTE_WORKER_CLI
  const candidates = [
    path.join(context.extensionPath, "bin", "kilo"),
    vscode.extensions.getExtension("hainuo-wang.kilo-remote-agent")?.extensionPath
      ? path.join(vscode.extensions.getExtension("hainuo-wang.kilo-remote-agent")!.extensionPath, "bin", "kilo")
      : undefined,
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? "kilo"
}

export function deactivate() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  worker?.dispose()
  worker = undefined
}
