import * as vscode from "vscode"
import {
  buildDuckcodingControllerConfig,
  DEFAULT_DUCKCODING_BASE_URL,
  DEFAULT_DUCKCODING_MODEL,
  migrateLegacyMiofficeSettings,
  normalizeDuckcodingSettings,
  type DuckcodingSettings,
} from "./duckcoding-config"

export const DUCKCODING_API_KEY_SECRET = "duckcoding.apiKey"
export const LEGACY_MIOFFICE_API_KEY_SECRET = "mioffice.apiKey"

type ConfigurationInspectLike = {
  globalValue?: unknown
  workspaceValue?: unknown
  workspaceFolderValue?: unknown
  globalLanguageValue?: unknown
  workspaceLanguageValue?: unknown
  workspaceFolderLanguageValue?: unknown
}

function hasExplicitValue(inspect: ConfigurationInspectLike | undefined): boolean {
  return (
    inspect?.globalValue !== undefined ||
    inspect?.workspaceValue !== undefined ||
    inspect?.workspaceFolderValue !== undefined ||
    inspect?.globalLanguageValue !== undefined ||
    inspect?.workspaceLanguageValue !== undefined ||
    inspect?.workspaceFolderLanguageValue !== undefined
  )
}

function settings(): DuckcodingSettings {
  const current = vscode.workspace.getConfiguration("kilo-code.new.experimental.duckcoding")
  const legacy = vscode.workspace.getConfiguration("kilo-code.new.experimental.mioffice")
  const explicitlyConfigured =
    hasExplicitValue(current.inspect<string>("baseURL")) ||
    hasExplicitValue(current.inspect<string>("model")) ||
    hasExplicitValue(current.inspect<string>("api"))

  if (explicitlyConfigured) {
    return normalizeDuckcodingSettings({
      baseURL: current.get<string>("baseURL", DEFAULT_DUCKCODING_BASE_URL),
      model: current.get<string>("model", DEFAULT_DUCKCODING_MODEL),
      api: current.get<string>("api", "responses") as DuckcodingSettings["api"],
    })
  }

  return migrateLegacyMiofficeSettings({
    baseURL: legacy.get<string>("baseURL"),
    model: legacy.get<string>("model"),
    api: legacy.get<string>("api") as DuckcodingSettings["api"] | undefined,
  })
}

export async function duckcodingControllerEnv(
  enabled: boolean,
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  if (!enabled) return {}
  const apiKey =
    (await context.secrets.get(DUCKCODING_API_KEY_SECRET))?.trim() ||
    (await context.secrets.get(LEGACY_MIOFFICE_API_KEY_SECRET))?.trim()
  if (!apiKey) return {}

  return {
    DUCKCODING_API_KEY: apiKey,
    KILO_CONFIG_CONTENT: JSON.stringify(buildDuckcodingControllerConfig(settings())),
  }
}

export async function configureDuckcoding(context: vscode.ExtensionContext): Promise<void> {
  const current =
    (await context.secrets.get(DUCKCODING_API_KEY_SECRET)) ||
    (await context.secrets.get(LEGACY_MIOFFICE_API_KEY_SECRET))
  const value = await vscode.window.showInputBox({
    title: "Configure DuckCoding API Key",
    prompt: "The key is stored in VS Code SecretStorage and is used only by the local Kilo controller.",
    password: true,
    ignoreFocusOut: true,
    value: current ? "••••••••" : undefined,
    validateInput: (input) => (input.trim() === "••••••••" ? "Enter the new API key." : undefined),
  })
  if (value === undefined) return

  const key = value.trim()
  if (!key) {
    await context.secrets.delete(DUCKCODING_API_KEY_SECRET)
    await context.secrets.delete(LEGACY_MIOFFICE_API_KEY_SECRET)
    void vscode.window.showInformationMessage("DuckCoding API key removed from VS Code SecretStorage.")
    return
  }

  await context.secrets.store(DUCKCODING_API_KEY_SECRET, key)
  void vscode.window.showInformationMessage(
    "DuckCoding API key stored locally. Reload the VS Code window before starting a new Kilo session.",
  )
}
