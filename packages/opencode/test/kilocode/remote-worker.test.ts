import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { RpcEvent, RpcMessage, RpcRequest, RpcResponse } from "@kilocode/kilo-remote-protocol"
import { RPC_VERSION } from "@kilocode/kilo-remote-protocol"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("remote worker", () => {
  test("serves workspace files and rejects paths outside the registered root", async () => {
    const root = await workspace()
    await writeFile(path.join(root, "sample.txt"), "alpha\nbeta\n")
    await writeFile(path.join(root, "nested", "sample.py"), "beta\n")
    const worker = spawnWorker(root)
    const beforeEdit = await worker.exchange([
      request("hello", "system.hello", {}),
      request("read", "fs.readFile", { rootId: "workspace", path: "sample.txt" }),
      request("grep", "search.grep", { rootId: "workspace", path: ".", pattern: "beta", include: "*.txt" }),
      request("grepNested", "search.grep", { rootId: "workspace", path: ".", pattern: "beta", include: "**/*.py" }),
    ])

    expect(response(beforeEdit, "hello").error).toBeUndefined()
    const read = response(beforeEdit, "read").result as { content: string }
    expect(Buffer.from(read.content, "base64").toString("utf8")).toBe("alpha\nbeta\n")
    const grep = response(beforeEdit, "grep").result as {
      matches: Array<{ path: string; line: number; column: number; text: string }>
    }
    expect(grep.matches).toEqual([{ path: "sample.txt", line: 2, column: 1, text: "beta" }])
    expect(
      (
        response(beforeEdit, "grepNested").result as {
          matches: Array<{ path: string; line: number; column: number; text: string }>
        }
      ).matches,
    ).toEqual([{ path: "nested/sample.py", line: 1, column: 1, text: "beta" }])

    const afterEdit = await spawnWorker(root).exchange([
      request("edit", "fs.editFile", {
        rootId: "workspace",
        path: "sample.txt",
        oldString: "beta",
        newString: "gamma",
      }),
      request("write", "fs.writeFile", {
        rootId: "workspace",
        path: "nested/out.txt",
        content: { encoding: "base64", data: Buffer.from("hello\n").toString("base64") },
      }),
      request("escape", "fs.readFile", { rootId: "workspace", path: "../outside.txt" }),
      request("root", "fs.listFiles", { rootId: "unknown" }),
    ])

    expect(response(afterEdit, "escape").error?.code).toBe("OUTSIDE_WORKSPACE")
    expect(response(afterEdit, "root").error?.code).toBe("UNKNOWN_ROOT")
    expect(await readFile(path.join(root, "sample.txt"), "utf8")).toBe("alpha\ngamma\n")
    expect(await readFile(path.join(root, "nested/out.txt"), "utf8")).toBe("hello\n")
  })

  test("streams complete stdout and stderr with byte counts", async () => {
    const root = await workspace()
    const worker = spawnWorker(root)
    const messages = await worker.exchange([
      request("process", "process.run", {
        rootId: "workspace",
        cwd: ".",
        command: "yes O | head -c 200000; yes E | head -c 150000 >&2",
      }),
    ])
    const events = messages
      .filter((message): message is RpcEvent => message.type === "event" && message.streamId === "process:process")
      .toSorted((a, b) => a.seq - b.seq)
    const stdout = bytes(events, "stdout")
    const stderr = bytes(events, "stderr")
    const exit = events.find((event) => event.event === "exit")?.data as {
      exitCode: number
      signal: string | null
      stdoutBytes: number
      stderrBytes: number
      truncated: boolean
    }

    expect(response(messages, "process").error).toBeUndefined()
    expect(stdout.byteLength).toBe(200_000)
    expect(stderr.byteLength).toBe(150_000)
    expect(exit).toEqual({
      exitCode: 0,
      signal: null,
      stdoutBytes: 200_000,
      stderrBytes: 150_000,
      truncated: false,
    })
  })

  test("forwards small output before the remote process exits", async () => {
    const root = await workspace()
    const worker = spawnWorker(root)
    worker.write(
      request("streaming", "process.run", {
        rootId: "workspace",
        cwd: ".",
        command: "printf 'early\\n'; sleep 1; printf 'late\\n'",
      }),
    )
    await worker.waitFor((message) => message.type === "response" && message.requestId === "streaming")
    const started = performance.now()
    await Promise.race([
      worker.waitFor(
        (message) =>
          message.type === "event" &&
          message.streamId === "streaming:process" &&
          message.event === "stdout" &&
          Buffer.from((message.data as { chunk: string }).chunk, "base64")
            .toString("utf8")
            .includes("early"),
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("early output was not streamed")), 750)),
    ])
    expect(performance.now() - started).toBeLessThan(750)
    expect(worker.messages.some((message) => message.type === "event" && message.event === "exit")).toBe(false)
    await worker.waitFor(
      (message) => message.type === "event" && message.streamId === "streaming:process" && message.event === "exit",
    )
    worker.end()
    await worker.done
  })

  test("closes stdin for non-interactive processes", async () => {
    const root = await workspace()
    const worker = spawnWorker(root)
    const messages = await worker.exchange([
      request("process", "process.run", {
        rootId: "workspace",
        cwd: ".",
        command: "cat",
      }),
    ])
    const events = messages.filter(
      (message): message is RpcEvent => message.type === "event" && message.streamId === "process:process",
    )

    expect(response(messages, "process").error).toBeUndefined()
    expect(events.find((event) => event.event === "exit")).toMatchObject({
      event: "exit",
      data: { exitCode: 0, stdoutBytes: 0, stderrBytes: 0 },
    })
  })

  test("cancels the remote process group", async () => {
    const root = await workspace()
    const worker = spawnWorker(root)
    worker.write(
      request("cancelled", "process.run", {
        rootId: "workspace",
        cwd: ".",
        command: "sleep 30; printf late",
      }),
    )
    await worker.waitFor((message) => message.type === "response" && message.requestId === "cancelled")
    const start = Date.now()
    worker.write({ type: "cancel", version: RPC_VERSION, requestId: "cancelled", streamId: "cancelled:process" })
    worker.end()
    const messages = await worker.done
    const exit = messages.find(
      (message): message is RpcEvent =>
        message.type === "event" && message.streamId === "cancelled:process" && message.event === "exit",
    )

    expect(Date.now() - start).toBeLessThan(5_000)
    expect(exit).toBeDefined()
    expect((exit!.data as { exitCode: number | null }).exitCode).not.toBe(0)
    expect(
      bytes(
        messages.filter((message): message is RpcEvent => message.type === "event"),
        "stdout",
      ).toString(),
    ).not.toContain("late")
  })

  test("honors cancellation that arrives before process spawn", async () => {
    const root = await workspace()
    const worker = spawnWorker(root)
    const marker = "cancelled-before-spawn"
    worker.write(
      request("early-cancel", "process.run", {
        rootId: "workspace",
        cwd: ".",
        command: `printf spawned > ${marker}`,
      }),
    )
    worker.write({ type: "cancel", version: RPC_VERSION, requestId: "early-cancel", streamId: "early-cancel:process" })
    await worker.waitFor((message) => message.type === "response" && message.requestId === "early-cancel")
    const messages = worker.messages
    worker.end()
    await worker.done

    expect(response(messages, "early-cancel").error).toMatchObject({
      code: "CANCELLED",
    })
    expect(await readFile(path.join(root, marker), "utf8").catch(() => undefined)).toBeUndefined()
  })

  test("does not expose controller credentials to remote commands", async () => {
    const root = await workspace()
    const worker = spawnWorker(root, {
      MIOFFICE_API_KEY: "team-secret",
      MIOFFICE_TEAM_KEY: "team-secret-variant",
      OPENAI_API_KEY: "openai-secret",
      KILO_CONFIG_CONTENT: '{"provider":{"mioffice":{"options":{"apiKey":"team-secret"}}}}',
      KILO_REMOTE_BRIDGE_TOKEN: "bridge-secret",
      KILO_SERVER_PASSWORD: "server-secret",
      KILO_API_KEY: "kilo-secret",
      KILO_AUTH_TOKEN: "auth-secret",
      KILOCODE_API_KEY: "kilocode-secret",
    })
    const messages = await worker.exchange([
      request("env", "process.run", {
        rootId: "workspace",
        cwd: ".",
        command: "env",
      }),
    ])
    const events = messages.filter(
      (message): message is RpcEvent => message.type === "event" && message.streamId === "env:process",
    )
    const output = bytes(events, "stdout").toString("utf8")

    expect(response(messages, "env").error).toBeUndefined()
    expect(output).not.toContain("MIOFFICE_API_KEY")
    expect(output).not.toContain("MIOFFICE_TEAM_KEY")
    expect(output).not.toContain("team-secret")
    expect(output).not.toContain("OPENAI_API_KEY")
    expect(output).not.toContain("KILO_CONFIG_CONTENT")
    expect(output).not.toContain("KILO_REMOTE_BRIDGE_TOKEN")
    expect(output).not.toContain("KILO_SERVER_PASSWORD")
    expect(output).not.toContain("KILO_API_KEY")
    expect(output).not.toContain("KILO_AUTH_TOKEN")
    expect(output).not.toContain("KILOCODE_API_KEY")
  })

  test("starts a PTY, forwards input, and applies resize", async () => {
    const root = await workspace()
    const worker = spawnWorker(root)
    worker.write(
      request("pty", "pty.start", {
        rootId: "workspace",
        cwd: ".",
        command: "printf 'ready\\n'; read line; printf 'got:%s\\n' \"$line\"",
        shell: "/bin/sh",
        cols: 80,
        rows: 24,
      }),
    )
    await worker.waitFor((message) => message.type === "response" && message.requestId === "pty")
    const accepted = response(worker.messages, "pty").result as { streamId: string; cols: number; rows: number }
    expect(accepted.cols).toBe(80)
    expect(accepted.rows).toBe(24)

    await worker.waitFor(
      (message) =>
        message.type === "event" &&
        message.streamId === accepted.streamId &&
        message.event === "stdout" &&
        Buffer.from((message.data as { chunk: string }).chunk, "base64")
          .toString("utf8")
          .includes("ready"),
    )
    worker.write(
      request("resize", "pty.resize", {
        streamId: accepted.streamId,
        cols: 120,
        rows: 40,
      }),
    )
    worker.write(
      request("input", "pty.input", {
        streamId: accepted.streamId,
        data: Buffer.from("hello\n").toString("base64"),
      }),
    )
    await worker.waitFor((message) => message.type === "response" && message.requestId === "resize")
    await worker.waitFor((message) => message.type === "response" && message.requestId === "input")
    await worker.waitFor(
      (message) => message.type === "event" && message.streamId === accepted.streamId && message.event === "exit",
    )
    worker.end()
    const messages = await worker.done
    const output = bytes(
      messages.filter(
        (message): message is RpcEvent => message.type === "event" && message.streamId === accepted.streamId,
      ),
      "stdout",
    ).toString("utf8")
    expect(output).toContain("ready")
    expect(output).toContain("got:hello")
    expect(messages.find((message) => message.type === "event" && message.event === "exit")).toBeDefined()
  })
})

function request(requestId: string, method: string, params: unknown): RpcRequest {
  return { type: "request", version: RPC_VERSION, requestId, method, params }
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kilo-remote-worker-"))
  roots.push(root)
  await mkdir(path.join(root, "nested"), { recursive: true })
  return root
}

function response(messages: RpcMessage[], requestId: string) {
  const message = messages.find(
    (candidate): candidate is RpcResponse => candidate.type === "response" && candidate.requestId === requestId,
  )
  if (!message) throw new Error(`Missing response for ${requestId}`)
  return message
}

function bytes(events: RpcEvent[], type: "stdout" | "stderr") {
  return Buffer.concat(
    events
      .filter((event) => event.event === type)
      .map((event) => Buffer.from((event.data as { chunk: string }).chunk, "base64")),
  )
}

function spawnWorker(root: string, extraEnv: Record<string, string> = {}) {
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
        ...extraEnv,
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_PURE: "1",
      },
    },
  )
  const messages: RpcMessage[] = []
  const waiters = new Set<{ match: (message: RpcMessage) => boolean; resolve: () => void }>()
  const done = (async () => {
    const decoder = new TextDecoder()
    let pending = ""
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      while (true) {
        const newline = pending.indexOf("\n")
        if (newline === -1) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line) as RpcMessage
        messages.push(message)
        for (const waiter of waiters) {
          if (!waiter.match(message)) continue
          waiters.delete(waiter)
          waiter.resolve()
        }
      }
    }
    const exit = await child.exited
    if (exit !== 0) throw new Error(`Remote worker exited ${exit}: ${await new Response(child.stderr).text()}`)
    return messages
  })()

  return {
    messages,
    done,
    write(message: RpcMessage) {
      child.stdin.write(JSON.stringify(message) + "\n")
      child.stdin.flush()
    },
    end() {
      child.stdin.end()
    },
    async exchange(requests: RpcRequest[]) {
      for (const message of requests) this.write(message)
      this.end()
      return done
    },
    waitFor(match: (message: RpcMessage) => boolean) {
      if (messages.some(match)) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.add({ match, resolve }))
    },
  }
}
