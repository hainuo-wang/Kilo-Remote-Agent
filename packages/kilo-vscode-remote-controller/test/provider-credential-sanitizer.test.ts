import { describe, expect, test } from "bun:test"
import {
  containsLiteralCredential,
  isCredentialResponsePath,
  isCredentialRequestPath,
  isProviderCatalogPath,
  sanitizeCredentialPayload,
  sanitizeProviderCatalog,
} from "../src/provider-credential-sanitizer"

describe("provider catalog credential sanitizer", () => {
  test("recognizes provider catalog endpoints only", () => {
    expect(isProviderCatalogPath("/provider")).toBe(true)
    expect(isProviderCatalogPath("/config/providers")).toBe(true)
    expect(isProviderCatalogPath("/config")).toBe(false)
    expect(isProviderCatalogPath("/session")).toBe(false)
  })

  test("recognizes configuration and authentication response endpoints", () => {
    expect(isCredentialResponsePath("/config")).toBe(true)
    expect(isCredentialResponsePath("/config/overlay")).toBe(true)
    expect(isCredentialResponsePath("/global/config")).toBe(true)
    expect(isCredentialResponsePath("/global/event")).toBe(true)
    expect(isCredentialResponsePath("/auth/mioffice")).toBe(true)
    expect(isCredentialResponsePath("/provider/mioffice/oauth/authorize")).toBe(true)
    expect(isCredentialResponsePath("/mcp/server/auth")).toBe(true)
    expect(isCredentialResponsePath("/session")).toBe(false)
  })

  test("recognizes credential-bearing request endpoints", () => {
    expect(isCredentialRequestPath("/auth/mioffice")).toBe(true)
    expect(isCredentialRequestPath("/config/overlay")).toBe(true)
    expect(isCredentialRequestPath("/global/config")).toBe(true)
    expect(isCredentialRequestPath("/session")).toBe(false)
  })

  test("detects literal credentials but allows environment references", () => {
    expect(containsLiteralCredential({ auth: { mioffice: { key: "team-key" } } })).toBe(true)
    expect(containsLiteralCredential({ type: "api", key: "team-key" })).toBe(true)
    expect(containsLiteralCredential({ provider: { mioffice: { options: { api_key: "team-key" } } } })).toBe(true)
    expect(containsLiteralCredential({ provider: { mioffice: { options: { access_token: "team-key" } } } })).toBe(true)
    expect(
      containsLiteralCredential({ provider: { mioffice: { options: { apiKey: "{env:MIOFFICE_API_KEY}" } } } }),
    ).toBe(false)
    expect(containsLiteralCredential({ metadata: { token: "not-a-credential" } })).toBe(false)
  })

  test("removes provider credentials without changing model metadata", () => {
    const input = {
      all: [
        {
          id: "mioffice",
          key: "team-key",
          options: {
            apiKey: "team-key",
            baseURL: "https://api.llm.mioffice.cn/v1",
            headers: { Authorization: "Bearer team-key", "x-provider": "mioffice" },
          },
          models: {
            "ppio/pa/gpt-5.6-sol": {
              id: "ppio/pa/gpt-5.6-sol",
              options: { reasoning: true },
              metadata: { token: "model-metadata-that-is-not-a-secret" },
            },
          },
        },
      ],
      connected: ["mioffice"],
    }

    const output = JSON.parse(sanitizeProviderCatalog(Buffer.from(JSON.stringify(input))).toString("utf8"))

    expect(output).toEqual({
      all: [
        {
          id: "mioffice",
          options: {
            baseURL: "https://api.llm.mioffice.cn/v1",
            headers: { "x-provider": "mioffice" },
          },
          models: {
            "ppio/pa/gpt-5.6-sol": {
              id: "ppio/pa/gpt-5.6-sol",
              options: { reasoning: true },
              metadata: { token: "model-metadata-that-is-not-a-secret" },
            },
          },
        },
      ],
      connected: ["mioffice"],
    })
  })

  test("sanitizes the config providers response shape", () => {
    const input = {
      providers: [
        {
          id: "custom",
          key: "custom-key",
          options: { apiKey: "custom-key", baseURL: "https://example.test/v1", region: "cn" },
          models: {},
        },
      ],
      default: { custom: "model" },
    }

    const output = JSON.parse(sanitizeProviderCatalog(Buffer.from(JSON.stringify(input))).toString("utf8"))

    expect(output).toEqual({
      providers: [
        {
          id: "custom",
          options: { baseURL: "https://example.test/v1", region: "cn" },
          models: {},
        },
      ],
      default: { custom: "model" },
    })
  })

  test("preserves invalid JSON bytes for the streaming fallback", () => {
    const input = Buffer.from("{invalid")
    expect(sanitizeProviderCatalog(input)).toEqual(input)
  })

  test("sanitizes config credentials while preserving unrelated token metadata", () => {
    const input = {
      provider: {
        mioffice: {
          options: {
            apiKey: "team-key",
            access_token: "also-secret",
            baseURL: "https://api.llm.mioffice.cn/v1",
          },
          models: {
            "model-id": {
              options: { reasoning: true },
              metadata: { token: "not-a-credential" },
            },
          },
        },
      },
      auth: { mioffice: { type: "api", key: "team-key", token: "also-secret" } },
      directAuth: { type: "oauth", access: "access-token", refresh: "refresh-token" },
      headers: { Authorization: "Bearer team-key", "x-safe": "keep" },
      unrelated: { token: "preserve" },
    }

    const output = JSON.parse(sanitizeCredentialPayload(Buffer.from(JSON.stringify(input))).toString("utf8"))

    expect(output).toEqual({
      provider: {
        mioffice: {
          options: {
            baseURL: "https://api.llm.mioffice.cn/v1",
          },
          models: {
            "model-id": {
              options: { reasoning: true },
              metadata: { token: "not-a-credential" },
            },
          },
        },
      },
      auth: { mioffice: { type: "api" } },
      directAuth: { type: "oauth" },
      headers: { "x-safe": "keep" },
      unrelated: { token: "preserve" },
    })
  })
})
