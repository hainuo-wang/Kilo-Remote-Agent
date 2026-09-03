#!/usr/bin/env bun
import { $ } from "bun"
import { chmod, cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import {
  copyKiloSandboxWorker,
  copySandboxResources,
  copyTreeSitterResources,
} from "../../kilo-vscode/src/services/cli-backend/cli-resources"

const target = process.env.KILO_REMOTE_CONTROLLER_TARGET ?? defaultTarget()
const config = targetConfig(target)
const packageDirectory = path.dirname(import.meta.dir)
const repoDirectory = path.resolve(packageDirectory, "../..")
const source = path.join(
  repoDirectory,
  "packages",
  "opencode",
  "dist",
  "@kilocode",
  config.cliDirectory,
  "bin",
  config.binary,
)
const destination = path.join(packageDirectory, "bin", config.binary)

await rm(path.join(packageDirectory, "bin"), { recursive: true, force: true })
await mkdir(path.dirname(destination), { recursive: true })

try {
  await cp(source, destination)
  await copyTreeSitterResources(source, destination)
  await copySandboxResources(source, destination)
  await copyKiloSandboxWorker(source, destination)
} catch {
  throw new Error(
    `Local controller CLI not found at ${source}. Build ${config.cliDirectory} in packages/opencode first, or set kilo-code.remoteController.cliPath.`,
  )
}

if (config.binary !== "kilo.exe") await chmod(destination, 0o755)
console.log(`Copied ${source} -> ${destination}`)

if (process.argv.includes("--package")) {
  const outputDirectory = path.join(packageDirectory, "out")
  await mkdir(outputDirectory, { recursive: true })
  const output = path.join(outputDirectory, `kilo-remote-agent-controller-${target}.vsix`)
  await $`bunx vsce package --no-dependencies --skip-license --target ${target} -o ${output}`.cwd(packageDirectory)
  console.log(`Created ${output}`)
}

function defaultTarget() {
  const platform = process.platform === "win32" ? "win32" : process.platform
  return `${platform}-${process.arch}`
}

function targetConfig(target: string) {
  const configs: Record<string, { cliDirectory: string; binary: "kilo" | "kilo.exe" }> = {
    "win32-x64": { cliDirectory: "cli-windows-x64", binary: "kilo.exe" },
    "win32-arm64": { cliDirectory: "cli-windows-arm64", binary: "kilo.exe" },
    "darwin-x64": { cliDirectory: "cli-darwin-x64", binary: "kilo" },
    "darwin-arm64": { cliDirectory: "cli-darwin-arm64", binary: "kilo" },
    "linux-x64": { cliDirectory: "cli-linux-x64", binary: "kilo" },
    "linux-arm64": { cliDirectory: "cli-linux-arm64", binary: "kilo" },
  }
  const value = configs[target]
  if (!value) throw new Error(`Unsupported local controller target: ${target}`)
  return value
}
