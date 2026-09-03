const CREDENTIAL_KEYS = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "kilocodetoken",
  "authtoken",
  "clientsecret",
  "password",
  "secret",
])

const AUTH_VALUE_KEYS = new Set(["key", "token", "access", "refresh", "expires"])

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "api-key",
  "apikey",
  "x-api-key",
  "x-goog-api-key",
  "x-kilocode-token",
])

const CREDENTIAL_RESPONSE_PATHS = new Set([
  "/provider",
  "/config",
  "/config/providers",
  "/config/effective",
  "/config/model-state",
  "/config/overlay",
  "/global/config",
  "/event",
  "/global/event",
  "/api/event",
  "/auth",
])

const CREDENTIAL_REQUEST_PATHS = new Set(["/auth", "/config", "/config/overlay", "/global/config"])
const CREDENTIAL_CONTAINER_KEYS = new Set([
  "auth",
  "authentication",
  "credential",
  "credentials",
  "secret",
  "secrets",
  "tokens",
])

export function isProviderCatalogPath(pathname: string): boolean {
  return pathname === "/provider" || pathname === "/config/providers"
}

export function isCredentialRequestPath(pathname: string): boolean {
  return CREDENTIAL_REQUEST_PATHS.has(pathname) || pathname.startsWith("/auth/")
}

export function isCredentialResponsePath(pathname: string): boolean {
  return (
    CREDENTIAL_RESPONSE_PATHS.has(pathname) ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/provider/") ||
    pathname.startsWith("/mcp/") ||
    pathname.startsWith("/kilo/")
  )
}

export function sanitizeProviderCatalog(body: Uint8Array): Buffer {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"))
  } catch {
    return Buffer.from(body)
  }

  const sanitized = sanitizeCatalogValue(value)
  return Buffer.from(JSON.stringify(sanitized), "utf8")
}

export function sanitizeCredentialPayload(body: Uint8Array): Buffer {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"))
  } catch {
    return Buffer.from(body)
  }

  const sanitized = sanitizeCredentialValue(value)
  return Buffer.from(JSON.stringify(sanitized.value), "utf8")
}

export function containsLiteralCredential(value: unknown, inCredentialContainer = false): boolean {
  if (Array.isArray(value)) return value.some((child) => containsLiteralCredential(child, inCredentialContainer))
  if (!value || typeof value !== "object") return false

  const credentialRecord = inCredentialContainer || isAuthRecord(value)
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key)
    const credentialKey = CREDENTIAL_KEYS.has(normalizedKey) || (credentialRecord && AUTH_VALUE_KEYS.has(normalizedKey))
    if (credentialKey) {
      if (typeof child === "string" && child.trim() && !isCredentialReference(child)) return true
      if (child && typeof child === "object" && containsLiteralCredential(child, true)) return true
      continue
    }
    if (containsLiteralCredential(child, inCredentialContainer || isCredentialContainer(key))) return true
  }
  return false
}

export function sanitizeCredentialValue(
  value: unknown,
  inCredentialContainer = false,
): {
  value: unknown
  changed: boolean
} {
  if (!value || typeof value !== "object") return { value, changed: false }
  if (Array.isArray(value)) {
    let changed = false
    const result = value.map((child) => {
      const sanitized = sanitizeCredentialValue(child, inCredentialContainer)
      changed ||= sanitized.changed
      return sanitized.value
    })
    return { value: result, changed }
  }

  let changed = false
  const credentialRecord = inCredentialContainer || isAuthRecord(value)
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key)
    if (CREDENTIAL_KEYS.has(normalizedKey) || (credentialRecord && AUTH_VALUE_KEYS.has(normalizedKey))) {
      changed = true
      continue
    }
    if (normalizedKey === "headers") {
      const sanitized = sanitizeHeadersValue(child)
      changed ||= sanitized.changed
      result[key] = sanitized.value
      continue
    }
    const sanitized = sanitizeCredentialValue(child, inCredentialContainer || isCredentialContainer(key))
    changed ||= sanitized.changed
    result[key] = sanitized.value
  }
  return { value: result, changed }
}

function sanitizeCatalogValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sanitizeCatalogValue)

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "all" || key === "providers") {
      result[key] = Array.isArray(child) ? child.map(sanitizeProviderInfo) : child
      continue
    }
    result[key] = child
  }
  return result
}

function sanitizeProviderInfo(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key)
    if (normalizedKey === "key") continue
    if (normalizedKey === "options") {
      result[key] = sanitizeCredentialContainer(child)
      continue
    }
    if (normalizedKey === "headers") {
      result[key] = sanitizeHeaders(child)
      continue
    }
    if (normalizedKey === "models" && child && typeof child === "object" && !Array.isArray(child)) {
      result[key] = Object.fromEntries(
        Object.entries(child).map(([modelID, model]) => [modelID, sanitizeModelInfo(model)]),
      )
      continue
    }
    result[key] = child
  }
  return result
}

function sanitizeModelInfo(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key)
    if (normalizedKey === "options") {
      result[key] = sanitizeCredentialContainer(child)
      continue
    }
    if (normalizedKey === "headers") {
      result[key] = sanitizeHeaders(child)
      continue
    }
    result[key] = child
  }
  return result
}

function sanitizeCredentialContainer(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(normalizeKey(key))) continue
    result[key] = child && typeof child === "object" ? sanitizeCredentialContainer(child) : child
  }
  return result
}

function sanitizeHeaders(value: unknown): unknown {
  return sanitizeHeadersValue(value).value
}

function sanitizeHeadersValue(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, changed: false }

  let changed = false
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (
      SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) ||
      /(?:authorization|api[-_]?key|token|secret|password)/i.test(key)
    ) {
      changed = true
      continue
    }
    result[key] = child
  }
  return { value: result, changed }
}

function isCredentialContainer(key: string | undefined): boolean {
  return key !== undefined && CREDENTIAL_CONTAINER_KEYS.has(normalizeKey(key))
}

function isAuthRecord(value: object): boolean {
  const type = (value as { type?: unknown }).type
  return type === "api" || type === "oauth" || type === "wellknown"
}

function isCredentialReference(value: string): boolean {
  return /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim())
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}
