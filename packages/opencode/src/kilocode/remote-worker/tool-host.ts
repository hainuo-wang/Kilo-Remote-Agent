import { Effect, Schema } from "effect"
import { posix } from "node:path"
import * as Tool from "@/tool/tool"
import { RemoteWorkerClient } from "./client"
import { Parameters as ReadParameters } from "@/tool/read"
import { Parameters as WriteParameters } from "@/tool/write"
import { Parameters as EditParameters } from "@/tool/edit"
import { Parameters as GrepParameters } from "@/tool/grep"
import { Parameters as GlobParameters } from "@/tool/glob"
import { Parameters as ShellParameters } from "@/tool/shell/prompt"
import { InstanceState } from "@/effect/instance-state"
import { RemoteTextDecoder } from "./text-decoder"

type TextMetadata = {
  output: string
  truncated?: boolean
  [key: string]: unknown
}

function normalized(input: string) {
  return input.replaceAll("\\", "/")
}

function remoteRoot(instance: { directory: string; remoteDirectory?: string }) {
  return posix.normalize(normalized(instance.remoteDirectory ?? instance.directory))
}

function remotePath(instance: { directory: string; remoteDirectory?: string }, input: string) {
  const root = remoteRoot(instance)
  const localRoot = posix.normalize(normalized(instance.directory))
  const value = normalized(input)
  if (value === localRoot || value.startsWith(`${localRoot}/`)) {
    return posix.join(root, value.slice(localRoot.length))
  }
  return posix.isAbsolute(value) ? posix.normalize(value) : posix.resolve(root, value)
}

function remoteResolve(instance: { directory: string; remoteDirectory?: string }, input: string | undefined) {
  return remotePath(instance, input ?? ".")
}

function splitGlob(pattern: string) {
  const normalized = pattern.replaceAll("\\", "/")
  const index = normalized.search(/[*?{[]/)
  if (index === -1) {
    const cut = normalized.lastIndexOf("/")
    return {
      base: cut < 0 ? "." : normalized.slice(0, cut) || "/",
      pattern: normalized.slice(cut + 1) || "*",
    }
  }
  const prefix = normalized.slice(0, index)
  const cut = prefix.lastIndexOf("/")
  if (cut < 0) return { base: ".", pattern: normalized }
  return {
    base: normalized.slice(0, cut) || "/",
    pattern: normalized.slice(cut + 1) || "*",
  }
}

function globRegex(pattern: string) {
  let output = "^"
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        output += ".*"
        index++
      } else {
        output += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      output += "[^/]"
      continue
    }
    if (char === "{") {
      const end = pattern.indexOf("}", index + 1)
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map((value) => value.replace(/[.*+^${}()|[\]\\]/g, "\\$&"))
        output += `(?:${alternatives.join("|")})`
        index = end
        continue
      }
    }
    output += char.replace(/[.*+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`${output}$`)
}

function failure(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function remoteFailureText(error: unknown) {
  return `Remote worker unavailable: ${failure(error).message}`
}

function isAbort(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function recoverRemote<A>(effect: Effect.Effect<A, unknown>) {
  return effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => (isAbort(error) ? Effect.interrupt : Effect.succeed({ ok: false as const, error }))),
  )
}

function outputText(content: string, filePath: string) {
  const lines = content.split(/\r?\n/)
  const body = lines.map((line, index) => `${index + 1}: ${line}`).join("\n")
  return `<path>${filePath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

export namespace RemoteToolHost {
  export const enabled = RemoteWorkerClient.enabled
  const supported = new Set([
    "invalid",
    "read",
    "write",
    "edit",
    "grep",
    "glob",
    "bash",
    "question",
    "todowrite",
    "task",
  ])

  export function replaceNamed<TaskDefinition extends Tool.Def, ReadDefinition extends Tool.Def>(tools: {
    task: TaskDefinition
    read: ReadDefinition
  }): { task: TaskDefinition; read: ReadDefinition } {
    if (!enabled()) return tools
    return { ...tools, read: read(tools.read) }
  }

  export function replace(tools: Tool.Def[]): Tool.Def[] {
    if (!enabled()) return tools
    return tools
      .filter((tool) => supported.has(tool.id))
      .map((tool) => {
        switch (tool.id) {
          case "read":
            return read(tool)
          case "write":
            return write(tool)
          case "edit":
            return edit(tool)
          case "grep":
            return grep(tool)
          case "glob":
            return glob(tool)
          case "bash":
            return bash(tool)
          default:
            return tool
        }
      })
  }

  function read<ReadDefinition extends Tool.Def>(original: ReadDefinition): ReadDefinition {
    return {
      ...original,
      execute: (params: Schema.Schema.Type<typeof ReadParameters>, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "read",
            patterns: [params.filePath],
            always: ["*"],
            metadata: {},
          })
          const instance = yield* InstanceState.context
          const result = yield* recoverRemote(
            Effect.tryPromise({
              try: () => RemoteWorkerClient.readFile(remotePath(instance, params.filePath), ctx.abort),
              catch: failure,
            }),
          )
          if (!result.ok) {
            const output = remoteFailureText(result.error)
            yield* ctx.metadata({
              metadata: { output, truncated: false, loaded: [] } satisfies TextMetadata,
            })
            return {
              title: params.filePath,
              output,
              metadata: { preview: output, truncated: false, loaded: [] },
            }
          }
          const content = Buffer.from(result.value.content, "base64").toString("utf8")
          const lines = content.split(/\r?\n/)
          const offset = Math.max(1, params.offset ?? 1)
          const limit = Math.max(1, params.limit ?? 2_000)
          const selected = lines.slice(offset - 1, offset - 1 + limit)
          const output = outputText(selected.join("\n"), params.filePath)
          yield* ctx.metadata({
            metadata: {
              output: selected.slice(0, 20).join("\n"),
              truncated: selected.length < lines.length,
              loaded: [],
            } satisfies TextMetadata,
          })
          return {
            title: params.filePath,
            output,
            metadata: {
              preview: selected.slice(0, 20).join("\n"),
              truncated: selected.length < lines.length,
              loaded: [],
            },
          }
        }),
    } as ReadDefinition
  }

  function write(original: Tool.Def): Tool.Def {
    return {
      ...original,
      execute: (params: Schema.Schema.Type<typeof WriteParameters>, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "edit",
            patterns: [params.filePath],
            always: ["*"],
            metadata: {},
          })
          const instance = yield* InstanceState.context
          const result = yield* recoverRemote(
            Effect.tryPromise({
              try: () => RemoteWorkerClient.writeFile(remotePath(instance, params.filePath), params.content, ctx.abort),
              catch: failure,
            }),
          )
          if (!result.ok) {
            return {
              title: params.filePath,
              output: remoteFailureText(result.error),
              metadata: { filepath: params.filePath, diagnostics: {}, remoteError: true },
            }
          }
          return {
            title: params.filePath,
            output: "Wrote file successfully.",
            metadata: { filepath: params.filePath, diagnostics: {} },
          }
        }),
    }
  }

  function edit(original: Tool.Def): Tool.Def {
    return {
      ...original,
      execute: (params: Schema.Schema.Type<typeof EditParameters>, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "edit",
            patterns: [params.filePath],
            always: ["*"],
            metadata: {},
          })
          const instance = yield* InstanceState.context
          const result = yield* recoverRemote(
            Effect.tryPromise({
              try: () =>
                RemoteWorkerClient.editFile(
                  remotePath(instance, params.filePath),
                  params.oldString,
                  params.newString,
                  params.replaceAll ?? false,
                  ctx.abort,
                ),
              catch: failure,
            }),
          )
          if (!result.ok) {
            return {
              title: params.filePath,
              output: remoteFailureText(result.error),
              metadata: { filepath: params.filePath, diagnostics: {}, remoteError: true },
            }
          }
          return {
            title: params.filePath,
            output: "File edited successfully.",
            metadata: { filepath: params.filePath, diagnostics: {} },
          }
        }),
    }
  }

  function grep(original: Tool.Def): Tool.Def {
    return {
      ...original,
      execute: (params: Schema.Schema.Type<typeof GrepParameters>, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {},
          })
          const instance = yield* InstanceState.context
          const result = yield* recoverRemote(
            Effect.tryPromise({
              try: () =>
                RemoteWorkerClient.grep(
                  {
                    pattern: params.pattern,
                    path: remotePath(instance, params.path ?? "."),
                    include: params.include,
                    limit: params.limit,
                  },
                  ctx.abort,
                ),
              catch: failure,
            }),
          )
          if (!result.ok) {
            return {
              title: params.pattern,
              output: remoteFailureText(result.error),
              metadata: { matches: 0, truncated: false, remoteError: true },
            }
          }
          const output =
            result.value.matches.length === 0
              ? "No files found"
              : [
                  `Found ${result.value.matches.length} matches`,
                  "",
                  ...result.value.matches.map((match) => `${match.path}:${match.line}: ${match.text}`),
                ].join("\n")
          return {
            title: params.pattern,
            output,
            metadata: { matches: result.value.matches.length, truncated: result.value.truncated },
          }
        }),
    }
  }

  function glob(original: Tool.Def): Tool.Def {
    return {
      ...original,
      execute: (params: Schema.Schema.Type<typeof GlobParameters>, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: { pattern: params.pattern, path: params.path },
          })

          const split = splitGlob(params.pattern)
          const root = remoteRoot(instance)
          const base = remoteResolve(instance, params.path ?? split.base)
          const requestedPattern = params.path ? params.pattern.replaceAll("\\", "/") : split.pattern
          const relativeBase = posix.relative(root, base)
          const rootPattern = relativeBase ? `${relativeBase}/${requestedPattern}` : requestedPattern
          const result = yield* recoverRemote(
            Effect.tryPromise({
              try: () => RemoteWorkerClient.listFiles(root, true, 10_000, ctx.abort),
              catch: failure,
            }),
          )
          if (!result.ok) {
            return {
              title: posix.relative(root, base),
              output: remoteFailureText(result.error),
              metadata: { count: 0, truncated: false, remoteError: true },
            }
          }
          const matcher = globRegex(rootPattern)
          const files = result.value.entries
            .filter((entry) => entry.type === "file" && matcher.test(entry.path))
            .slice(0, 100)
          const truncated =
            result.value.entries.length >= 10_000 ||
            files.length <
              result.value.entries.filter((entry) => entry.type === "file" && matcher.test(entry.path)).length
          const output = files.length
            ? [
                ...files.map((entry) => posix.join(root, entry.path)),
                ...(truncated
                  ? [
                      "",
                      "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)",
                    ]
                  : []),
              ].join("\n")
            : "No files found"
          return {
            title: posix.relative(root, base),
            metadata: { count: files.length, truncated },
            output,
          }
        }),
    }
  }

  function bash(original: Tool.Def): Tool.Def {
    return {
      ...original,
      execute: (params: Schema.Schema.Type<typeof ShellParameters>, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "bash",
            patterns: [params.command],
            always: ["*"],
            metadata: { command: params.command },
          })
          const instance = yield* InstanceState.context
          let output = ""
          const stdoutDecoder = new RemoteTextDecoder()
          const stderrDecoder = new RemoteTextDecoder()
          const result = yield* recoverRemote(
            Effect.tryPromise({
              try: () =>
                RemoteWorkerClient.runProcess(
                  {
                    rootId: "workspace",
                    command: params.command,
                    cwd: remotePath(instance, params.workdir ?? "."),
                    timeoutMs: params.timeout,
                  },
                  ctx.abort,
                  (event) => {
                    if (event.event !== "stdout" && event.event !== "stderr") return
                    const chunk = decodeOutputChunk(
                      event.data,
                      event.event === "stdout" ? stdoutDecoder : stderrDecoder,
                    )
                    if (chunk === undefined) return
                    output += chunk
                    void Effect.runPromise(ctx.metadata({ metadata: { output } }))
                  },
                ),
              catch: failure,
            }),
          )
          output += stdoutDecoder.end()
          output += stderrDecoder.end()
          if (!result.ok) {
            const remoteError = remoteFailureText(result.error)
            const failedOutput = output ? `${output}\n${remoteError}` : remoteError
            return {
              title: params.description ?? params.command,
              output: failedOutput,
              metadata: {
                output,
                exit: null,
                description: params.description ?? params.command,
                truncated: false,
                remoteError: true,
              },
            }
          }
          const exit = result.value.exit.exitCode
          return {
            title: params.description ?? params.command,
            output: output || "(no output)",
            metadata: {
              output,
              exit,
              description: params.description ?? params.command,
              truncated: false,
            },
          }
        }),
    }
  }
}

function decodeOutputChunk(data: unknown, decoder: RemoteTextDecoder): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const value = data as Record<string, unknown>
  if (value.encoding !== "base64" || typeof value.chunk !== "string") return undefined
  return decoder.decode(Buffer.from(value.chunk, "base64"))
}
