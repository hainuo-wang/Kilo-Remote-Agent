import { spawn as nativeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"

export { type ChildProcess }

export function spawn(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return nativeSpawn(command, args, { windowsHide: true, ...options })
}
