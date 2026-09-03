import { describe, expect, test } from "bun:test"
import {
  buildDuckcodingControllerConfig,
  DEFAULT_DUCKCODING_BASE_URL,
  DEFAULT_DUCKCODING_MODEL,
  migrateLegacyMiofficeSettings,
  normalizeDuckcodingSettings,
} from "../src/duckcoding-config"

describe("DuckCoding controller configuration", () => {
  test("uses DuckCoding model and Responses API", () => {
    const config = buildDuckcodingControllerConfig({
      baseURL: DEFAULT_DUCKCODING_BASE_URL,
      model: DEFAULT_DUCKCODING_MODEL,
      api: "responses",
    })

    expect(config).toMatchObject({
      model: "duckcoding/gpt-5.6-sol",
      provider: {
        duckcoding: {
          npm: "@ai-sdk/openai",
          options: {
            apiKey: "{env:DUCKCODING_API_KEY}",
            baseURL: DEFAULT_DUCKCODING_BASE_URL,
          },
          models: {
            "gpt-5.6-sol": {
              name: "gpt-5.6-sol",
            },
          },
        },
      },
    })
  })

  test("migrates the previous DuckCoding settings without retaining PPIO", () => {
    expect(
      migrateLegacyMiofficeSettings({
        baseURL: "https://www.duckcoding.ai/v1",
        model: "ppio/pa/gpt-5.6-sol",
        api: "chat",
      }),
    ).toEqual({
      baseURL: DEFAULT_DUCKCODING_BASE_URL,
      model: "gpt-5.6-sol",
      api: "responses",
    })
  })

  test("preserves explicitly configured legacy Mioffice settings", () => {
    expect(
      migrateLegacyMiofficeSettings({
        baseURL: "https://api.llm.mioffice.cn/v1",
        model: "ppio/pa/gpt-5.6-sol",
        api: "responses",
      }),
    ).toEqual({
      baseURL: "https://api.llm.mioffice.cn/v1",
      model: "ppio/pa/gpt-5.6-sol",
      api: "responses",
    })
  })

  test("normalizes the website URL to DuckCoding's API endpoint", () => {
    expect(
      normalizeDuckcodingSettings({
        baseURL: "https://www.duckcoding.ai/v1",
        model: "gpt-5.6-sol",
        api: "responses",
      }),
    ).toMatchObject({
      baseURL: DEFAULT_DUCKCODING_BASE_URL,
    })
  })

  test("normalizes the previous regional endpoint to DuckCoding's API endpoint", () => {
    expect(
      normalizeDuckcodingSettings({
        baseURL: "https://jp.duckcoding.com/v1",
        model: "gpt-5.6-sol",
        api: "responses",
      }),
    ).toMatchObject({
      baseURL: DEFAULT_DUCKCODING_BASE_URL,
    })
  })
})
