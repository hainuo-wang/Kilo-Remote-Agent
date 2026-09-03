export type DuckcodingSettings = {
  baseURL: string
  model: string
  api: "responses" | "chat"
}

export const DEFAULT_DUCKCODING_BASE_URL = "https://api.duckcoding.ai/v1"
export const DEFAULT_DUCKCODING_MODEL = "gpt-5.6-sol"
export const LEGACY_MIOFFICE_BASE_URL = "https://api.llm.mioffice.cn/v1"
export const LEGACY_MIOFFICE_MODEL = "ppio/pa/gpt-5.6-sol"

export type LegacyMiofficeSettings = Partial<DuckcodingSettings>

export function normalizeDuckcodingSettings(
  settings: Partial<DuckcodingSettings>,
  defaults: DuckcodingSettings = {
    baseURL: DEFAULT_DUCKCODING_BASE_URL,
    model: DEFAULT_DUCKCODING_MODEL,
    api: "responses",
  },
): DuckcodingSettings {
  const api = settings.api?.trim().toLowerCase()
  return {
    baseURL: normalizeDuckcodingBaseURL(settings.baseURL?.trim() || defaults.baseURL),
    model: settings.model?.trim() || defaults.model,
    api: api === "chat" ? "chat" : api === "responses" ? "responses" : defaults.api,
  }
}

function normalizeDuckcodingBaseURL(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, "")
  if (
    normalized === "https://www.duckcoding.ai" ||
    normalized === "https://www.duckcoding.ai/v1" ||
    normalized === "https://jp.duckcoding.com" ||
    normalized === "https://jp.duckcoding.com/v1"
  ) {
    return DEFAULT_DUCKCODING_BASE_URL
  }
  return baseURL
}

export function migrateLegacyMiofficeSettings(settings: LegacyMiofficeSettings): DuckcodingSettings {
  const normalized = normalizeDuckcodingSettings(settings, {
    baseURL: LEGACY_MIOFFICE_BASE_URL,
    model: LEGACY_MIOFFICE_MODEL,
    api: "responses",
  })
  if (!/duckcoding/i.test(normalized.baseURL)) return normalized

  return {
    baseURL: normalized.baseURL,
    model: normalized.model === LEGACY_MIOFFICE_MODEL ? DEFAULT_DUCKCODING_MODEL : normalized.model,
    api: "responses",
  }
}

export function buildDuckcodingControllerConfig(settings: DuckcodingSettings): Record<string, unknown> {
  return {
    model: `duckcoding/${settings.model}`,
    provider: {
      duckcoding: {
        npm: settings.api === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
        options: {
          apiKey: "{env:DUCKCODING_API_KEY}",
          baseURL: settings.baseURL,
        },
        models: {
          [settings.model]: {
            name: settings.model,
            tool_call: true,
            reasoning: true,
            temperature: false,
            limit: {
              context: 200_000,
              output: 32_768,
            },
          },
        },
      },
    },
  }
}
