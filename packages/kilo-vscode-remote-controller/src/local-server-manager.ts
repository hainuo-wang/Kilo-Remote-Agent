import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"
import * as vscode from "vscode"
import { spawn, type ChildProcess } from "./process"

export type LocalServerInstance = {
  port: number
  password: string
  process: ChildProcess
}

type LocalServerManagerOptions = {
  context: vscode.ExtensionContext
  cliPath?: string
  env?: () => Promise<Record<string, string>>
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

const STARTUP_TIMEOUT_MS = 30_000
const STARTUP_OUTPUT_LIMIT = 8_192

export class LocalServerManager implements vscode.Disposable {
  private instance: LocalServerInstance | undefined
  private startupPromise: Promise<LocalServerInstance> | undefined
  private startingProcess: ChildProcess | undefined
  private disposed = false

  constructor(private readonly options: LocalServerManagerOptions) {}

  async getServer(): Promise<LocalServerInstance> {
    if (this.disposed) throw new Error("Local Kilo server manager is disposed")
    if (this.instance) return this.instance
    if (this.startupPromise) return this.startupPromise

    this.startupPromise = this.start()
    try {
      this.instance = await this.startupPromise
      return this.instance
    } finally {
      this.startupPromise = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    const instance = this.instance
    this.instance = undefined
    const process = instance?.process ?? this.startingProcess
    terminate(process)
    this.startingProcess = undefined
    if (!process) return
    const fallback = setTimeout(() => {
      if (process.exitCode === null) terminate(process, "SIGKILL")
    }, 5_000)
    fallback.unref()
    process.once("exit", () => clearTimeout(fallback))
  }

  private async start(): Promise<LocalServerInstance> {
    const cliPath =
      this.options.cliPath ??
      path.join(this.options.context.extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
    if (!existsSync(cliPath)) {
      throw new Error(`Local Kilo CLI not found at ${cliPath}`)
    }

    const cliStat = statSync(cliPath)
    if (!cliStat.isFile()) throw new Error(`Local Kilo CLI path is not a file: ${cliPath}`)

    const password = randomBytes(32).toString("hex")
    const storage = this.options.context.globalStorageUri.fsPath
    mkdirSync(storage, { recursive: true })
    const config = vscode.workspace.getConfiguration("kilo-code.new")
    const extraCaCerts = config.get<string>("extraCaCerts", "").trim()
    const proxyStrictSSL = vscode.workspace.getConfiguration("http").get<boolean>("proxyStrictSSL", true)
    const extraEnv = await this.options.env?.()
    const child = spawn(cliPath, ["serve", "--port", "0", "--hostname", "127.0.0.1", "--no-mdns"], {
      cwd: storage,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_USE_SYSTEM_CA: "1",
        ...(extraCaCerts ? { NODE_EXTRA_CA_CERTS: extraCaCerts } : {}),
        ...(!proxyStrictSSL ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
        KILO_DISABLE_CHANNEL_DB: "true",
        KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        KILO_DISABLE_CODEBASE_INDEXING: "cursor-like-remote",
        KILO_PARENT_PID: String(process.pid),
        KILO_CLIENT: "vscode",
        KILO_ENABLE_QUESTION_TOOL: "true",
        KILOCODE_FEATURE: "vscode-extension",
        KILO_TELEMETRY_LEVEL: vscode.env.isTelemetryEnabled ? "all" : "off",
        KILO_APP_NAME: "kilo-code",
        KILO_EDITOR_NAME: vscode.env.appName,
        KILO_PLATFORM: "vscode",
        KILO_MACHINE_ID: vscode.env.machineId,
        KILO_APP_VERSION: this.options.context.extension.packageJSON.version,
        KILO_VSCODE_VERSION: vscode.version,
        KILOCODE_VERSION: this.options.context.extension.packageJSON.version,
        KILOCODE_EDITOR_NAME: `${vscode.env.appName} ${vscode.version}`,
        KILO_DISABLE_CLAUDE_CODE: "true",
        KILO_TREE_SITTER_WASM_DIR: path.join(this.options.context.extensionPath, "bin", "tree-sitter"),
        ...buildProxyEnv(),
        ...extraEnv,
        KILO_SERVER_PASSWORD: password,
      },
    })
    this.startingProcess = child
    if (this.disposed) {
      terminate(child)
      throw new Error("Local Kilo server manager is disposed")
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let output = ""
      let stderr = ""
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        terminate(child)
        reject(new Error(`Local Kilo server did not start within ${STARTUP_TIMEOUT_MS}ms\n${stderr}`.trim()))
      }, STARTUP_TIMEOUT_MS)

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        terminate(child)
        reject(error)
      }

      const started = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-STARTUP_OUTPUT_LIMIT)
        const match = output.match(/kilo server listening on http:\/\/[^:\s]+:(\d+)/i)
        if (!match || settled) return
        settled = true
        clearTimeout(timeout)
        this.startingProcess = undefined
        resolve({ port: Number(match[1]), password, process: child })
      }

      child.stdout?.on("data", started)
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-STARTUP_OUTPUT_LIMIT)
      })
      child.once("error", (error) => fail(error))
      child.once("exit", (code, signal) => {
        if (!settled) {
          fail(
            new Error(
              `Local Kilo server exited before startup (${code ?? "null"}, ${signal ?? "null"})\n${stderr}`.trim(),
            ),
          )
          return
        }
        if (this.instance?.process === child) this.instance = undefined
        if (this.startingProcess === child) this.startingProcess = undefined
        this.options.onExit?.(code, signal)
      })
    })
  }
}

function terminate(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child || child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    return
  }
}

function buildProxyEnv(): Record<string, string> {
  const controllerProxy = vscode.workspace.getConfiguration("kilo-code.remoteController").get<string>("proxy", "").trim()
  const config = vscode.workspace.getConfiguration("http")
  const proxy = controllerProxy || config.get<string>("proxy")
  const noProxy = config.get<string[]>("noProxy")
  const proxyInfo = config.inspect<string>("proxy")
  const noProxyInfo = config.inspect<string[]>("noProxy")
  const env: Record<string, string> = {}
  const proxySet =
    proxyInfo !== undefined &&
    [
      proxyInfo.globalValue,
      proxyInfo.workspaceValue,
      proxyInfo.workspaceFolderValue,
      proxyInfo.globalLanguageValue,
      proxyInfo.workspaceLanguageValue,
      proxyInfo.workspaceFolderLanguageValue,
    ].some((value) => value !== undefined)
  const noProxySet =
    noProxyInfo !== undefined &&
    [
      noProxyInfo.globalValue,
      noProxyInfo.workspaceValue,
      noProxyInfo.workspaceFolderValue,
      noProxyInfo.globalLanguageValue,
      noProxyInfo.workspaceLanguageValue,
      noProxyInfo.workspaceFolderLanguageValue,
    ].some((value) => value !== undefined)

  if (!controllerProxy && config.get<string>("proxySupport") === "off") {
    return {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      no_proxy: "",
    }
  }
  if (proxy?.trim()) {
    const value = proxy.trim()
    env.HTTP_PROXY = value
    env.HTTPS_PROXY = value
    env.http_proxy = value
    env.https_proxy = value
  } else if (proxySet) {
    env.HTTP_PROXY = ""
    env.HTTPS_PROXY = ""
    env.http_proxy = ""
    env.https_proxy = ""
  }
  if (Array.isArray(noProxy) && noProxy.length > 0) {
    env.NO_PROXY = noProxy.join(",")
    env.no_proxy = noProxy.join(",")
  } else if (noProxySet) {
    env.NO_PROXY = ""
    env.no_proxy = ""
  }
  return env
}
