import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionProcessor } from "@/session/processor"
import { Instruction } from "@/session/instruction"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "@/question"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { WebSocketServer, type WebSocket } from "ws"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { RpcMessage } from "@kilocode/kilo-remote-protocol"

const environment = {
  toolHost: process.env.KILO_REMOTE_TOOL_HOST,
  bridgeUrl: process.env.KILO_REMOTE_BRIDGE_URL,
  bridgeToken: process.env.KILO_REMOTE_BRIDGE_TOKEN,
}

afterEach(() => {
  restore("KILO_REMOTE_TOOL_HOST", environment.toolHost)
  restore("KILO_REMOTE_BRIDGE_URL", environment.bridgeUrl)
  restore("KILO_REMOTE_BRIDGE_TOKEN", environment.bridgeToken)
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const memoryNode = LayerNode.make({ service: MemoryService.Service, layer: MemoryService.layer, deps: [] })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}
const agent = {
  name: "build",
  mode: "primary" as const,
  native: true,
  permission: Permission.fromConfig({ "*": "allow" }),
  model,
  options: {},
}
const agents = Layer.mock(AgentSvc.Service)({
  get: () => Effect.succeed(agent),
  list: () => Effect.succeed([agent]),
  defaultInfo: () => Effect.succeed(agent),
  defaultAgent: () => Effect.succeed(agent.name),
})

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  memoryNode,
  testLLMServerNode,
])

const it = testEffect(
  LayerNode.compile(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [KiloSessions.node, KiloSessions.testLayer],
    [AgentSvc.node, agents],
  ]),
)

const config = (url: string) => ({
  model: "test/test-model",
  enabled_providers: ["test"],
  snapshot: false,
  permission: { "*": "allow" as const },
  provider: {
    test: {
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          limit: { context: 100_000, output: 10_000 },
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

describe("remote agent loop", () => {
  it.live(
    "reads, edits, and executes a remote workspace through the worker",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          const remote = yield* Effect.promise(() => createRemoteWorkspace())
          yield* Effect.addFinalizer(() => Effect.promise(() => remote.dispose()))
          yield* Effect.promise(() => writeFile(path.join(remote.root, "sample.py"), "def value():\n    return 1\n"))

          yield* Effect.promise(() => writeConfig(dir, config(llm.url)))
          yield* Effect.promise(() => configureEnvironment(remote.url))
          const local = yield* InstanceState.context
          const instance = { ...local, remoteDirectory: remote.root }

          yield* llm.push(
            reply().tool("read", { filePath: "sample.py" }),
            reply().tool("edit", {
              filePath: "sample.py",
              oldString: "return 1",
              newString: "return 2",
            }),
            reply().tool("bash", {
              command: "python3 -c 'from sample import value; print(value())'",
              workdir: ".",
            }),
            reply().text("done").stop(),
          )

          const result = yield* Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({
              title: "Remote loop",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [{ type: "text", text: "Read sample.py, change it, and run the test." }],
            })
            return yield* prompt.loop({ sessionID: session.id })
          }).pipe(Effect.provideService(InstanceRef, instance))

          expect(result.info.role).toBe("assistant")
          expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
          expect(yield* Effect.promise(() => readFile(path.join(remote.root, "sample.py"), "utf8"))).toContain(
            "return 2",
          )
          expect(yield* llm.calls).toBe(4)
          expect(remote.commands()).toContain("python3 -c")
          expect(remote.output()).toContain("2")
        }),
        { config },
      ),
    30_000,
  )
})

async function createRemoteWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kilo-remote-agent-"))
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  const clients = new Set<WebSocket>()
  const commandLog: string[] = []
  const outputLog: string[] = []
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=node",
      path.join(import.meta.dir, "../../src/index.ts"),
      "remote-worker",
      "--stdio",
      "--root",
      root,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_PURE: "1",
      },
    },
  )
  const listening = new Promise<void>((resolve) => server.once("listening", () => resolve()))
  server.on("connection", (socket) => {
    clients.add(socket)
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RpcMessage
      if (message.type === "request" && message.method === "process.run") {
        const params = message.params as { command?: string }
        if (params.command) commandLog.push(params.command)
      }
      child.stdin.write(data.toString() + "\n")
      child.stdin.flush()
    })
    socket.once("close", () => clients.delete(socket))
  })

  const forward = (async () => {
    const decoder = new TextDecoder()
    let pending = ""
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      while (true) {
        const newline = pending.indexOf("\n")
        if (newline === -1) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line) as RpcMessage
        if (message.type === "event" && (message.event === "stdout" || message.event === "stderr")) {
          const data = message.data as { chunk?: string }
          if (data.chunk) outputLog.push(Buffer.from(data.chunk, "base64").toString("utf8"))
        }
        const serialized = JSON.stringify(message)
        for (const socket of clients) {
          if (socket.readyState === socket.OPEN) socket.send(serialized)
        }
      }
    }
  })()
  void new Response(child.stderr).text().catch(() => undefined)
  await listening
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Remote bridge did not bind")

  return {
    root,
    url: `ws://127.0.0.1:${address.port}`,
    commands: () => commandLog.join("\n"),
    output: () => outputLog.join(""),
    dispose: async () => {
      for (const socket of clients) socket.terminate()
      child.kill("SIGKILL")
      void child.exited
      void forward.catch(() => undefined)
      server.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function writeConfig(directory: string, value: object) {
  await writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", ...value }),
  )
}

async function configureEnvironment(url: string) {
  process.env.KILO_REMOTE_TOOL_HOST = "1"
  process.env.KILO_REMOTE_BRIDGE_URL = url
  process.env.KILO_REMOTE_BRIDGE_TOKEN = "integration-test"
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
