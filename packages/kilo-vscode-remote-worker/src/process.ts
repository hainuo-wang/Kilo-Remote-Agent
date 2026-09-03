import { spawn as nativeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process"

export { type ChildProcessWithoutNullStreams }

export function spawn(command: string, args: string[], options: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  return nativeSpawn(command, args, { windowsHide: true, ...options }) as ChildProcessWithoutNullStreams
}
