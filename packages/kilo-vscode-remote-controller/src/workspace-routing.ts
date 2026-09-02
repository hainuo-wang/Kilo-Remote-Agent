import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"

const DIRECTORY_QUERY_KEYS = ["directory", "location[directory]"] as const

export function virtualWorkspaceDirectory(
  globalStoragePath: string,
  remoteName: string | undefined,
  workspaceAuthority: string | undefined,
  remoteDirectory: string,
): string {
  const identity = `${remoteName ?? "local"}\0${workspaceAuthority ?? "local"}\0${remoteDirectory}`
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24)
  const directory = path.join(globalStoragePath, "remote-workspaces", digest)
  mkdirSync(directory, { recursive: true })
  return directory
}

export function rewriteWorkspaceDirectory(url: URL, virtualDirectory: string): void {
  for (const key of DIRECTORY_QUERY_KEYS) {
    if (url.searchParams.has(key)) url.searchParams.set(key, virtualDirectory)
  }
}
