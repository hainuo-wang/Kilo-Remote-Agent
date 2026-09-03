import * as vscode from "vscode"
import type {
  ControllerPtyCloseRequest,
  ControllerPtyCreateRequest,
  ControllerPtyCreateResponse,
  ControllerPtyResizeRequest,
} from "@kilocode/kilo-remote-protocol"
import { REMOTE_COMMANDS } from "@kilocode/kilo-remote-protocol"

const COMMAND_HANDSHAKE_TIMEOUT_MS = 120_000

export type CursorRemotePty = {
  create(input: ControllerPtyCreateRequest): Promise<ControllerPtyCreateResponse>
  resize(input: ControllerPtyResizeRequest): Promise<void>
  close(input: ControllerPtyCloseRequest): Promise<void>
}

export function createCursorRemotePty(): CursorRemotePty | undefined {
  if (!isSshRemote()) return undefined
  if (!vscode.workspace.getConfiguration("kilo-code.new.experimental").get("cursorLikeRemote", false)) {
    return undefined
  }

  return {
    async create(input) {
      const result = await execute<ControllerPtyCreateResponse | undefined>(
        REMOTE_COMMANDS.controllerPtyCreate,
        input,
        true,
      )
      if (!result || typeof result.wsUrl !== "string" || typeof result.streamId !== "string") {
        throw new Error("Local Kilo controller returned an invalid remote PTY response")
      }
      return result
    },
    async resize(input) {
      await execute(REMOTE_COMMANDS.controllerPtyResize, input)
    },
    async close(input) {
      await execute(REMOTE_COMMANDS.controllerPtyClose, input)
    },
  }
}

function isSshRemote(): boolean {
  return vscode.env.remoteName?.startsWith("ssh-remote") ?? false
}

async function execute<T>(command: string, input: unknown, retryInvalid = false): Promise<T> {
  const deadline = Date.now() + COMMAND_HANDSHAKE_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await vscode.commands.executeCommand<T>(command, input)
      if (!retryInvalid || result !== undefined) return result
      lastError = new Error(`Local Kilo controller command ${command} is not ready`)
    } catch (error) {
      if (!isCommandUnavailable(error)) throw error
      lastError = error
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())))
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Local Kilo controller command ${command} timed out after ${COMMAND_HANDSHAKE_TIMEOUT_MS}ms`)
}

function isCommandUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /command .*not found|command .*not registered|no such command/i.test(message)
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
}
