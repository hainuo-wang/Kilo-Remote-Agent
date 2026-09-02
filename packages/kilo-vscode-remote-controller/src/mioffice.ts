import * as vscode from "vscode"

export const MIOFFICE_API_KEY_SECRET = "mioffice.apiKey"

const DEFAULT_BASE_URL = "https://api.llm.mioffice.cn/v1"
const DEFAULT_MODEL = "ppio/pa/gpt-5.6-sol"

type MiofficeSettings = {
  baseURL: string
  model: string
  api: "responses" | "chat"
}

function settings(): MiofficeSettings {
  const config = vscode.workspace.getConfiguration("kilo-code.new.experimental.mioffice")
  const api = config.get<string>("api", "responses").trim().toLowerCase()
  return {
    baseURL: config.get<string>("baseURL", DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    model: config.get<string>("model", DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    api: api === "chat" ? "chat" : "responses",
  }
}

export async function miofficeControllerEnv(
  enabled: boolean,
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  if (!enabled) return {}
  const apiKey = (await context.secrets.get(MIOFFICE_API_KEY_SECRET))?.trim()
  if (!apiKey) return {}

  const config = settings()
  return {
    MIOFFICE_API_KEY: apiKey,
    KILO_CONFIG_CONTENT: JSON.stringify({
      model: `mioffice/${config.model}`,
      provider: {
        mioffice: {
          npm: config.api === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
          options: {
            apiKey: "{env:MIOFFICE_API_KEY}",
            baseURL: config.baseURL,
          },
          models: {
            [config.model]: {
              name: config.model,
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
    }),
  }
}

export async function configureMioffice(context: vscode.ExtensionContext): Promise<void> {
  const current = await context.secrets.get(MIOFFICE_API_KEY_SECRET)
  const value = await vscode.window.showInputBox({
    title: "Configure Mioffice API Key",
    prompt: "The key is stored in VS Code SecretStorage and is used only by the local Kilo controller.",
    password: true,
    ignoreFocusOut: true,
    value: current ? "••••••••" : undefined,
    validateInput: (input) => (input.trim() === "••••••••" ? "Enter the new API key." : undefined),
  })
  if (value === undefined) return

  const key = value.trim()
  if (!key) {
    await context.secrets.delete(MIOFFICE_API_KEY_SECRET)
    void vscode.window.showInformationMessage("Mioffice API key removed from VS Code SecretStorage.")
  } else {
    await context.secrets.store(MIOFFICE_API_KEY_SECRET, key)
    void vscode.window.showInformationMessage(
      "Mioffice API key stored locally. Reload the VS Code window before starting a new Kilo session.",
    )
  }
}
