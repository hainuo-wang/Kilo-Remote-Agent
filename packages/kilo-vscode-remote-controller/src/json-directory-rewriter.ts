const DIRECTORY_KEYS = new Set(["directory", "worktree", "currentDirectory", "cwd"])

export function rewriteJsonDirectories(body: Uint8Array, virtualDirectory: string, remoteDirectory: string): Buffer {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"))
  } catch {
    return Buffer.from(body)
  }

  const rewritten = rewriteJsonValue(value, virtualDirectory, remoteDirectory)
  return rewritten.changed ? Buffer.from(JSON.stringify(rewritten.value), "utf8") : Buffer.from(body)
}

export function rewriteJsonValue(
  value: unknown,
  virtualDirectory: string,
  remoteDirectory: string,
): { value: unknown; changed: boolean } {
  return rewriteValue(value, undefined, virtualDirectory, remoteDirectory)
}

function rewriteValue(
  value: unknown,
  key: string | undefined,
  virtualDirectory: string,
  remoteDirectory: string,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    return DIRECTORY_KEYS.has(key ?? "") && value === virtualDirectory
      ? { value: remoteDirectory, changed: true }
      : { value, changed: false }
  }

  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const result = rewriteValue(item, undefined, virtualDirectory, remoteDirectory)
      changed ||= result.changed
      return result.value
    })
    return { value: changed ? next : value, changed }
  }

  if (!value || typeof value !== "object") return { value, changed: false }

  let changed = false
  const next: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const result = rewriteValue(childValue, childKey, virtualDirectory, remoteDirectory)
    changed ||= result.changed
    next[childKey] = result.value
  }
  return { value: changed ? next : value, changed }
}
