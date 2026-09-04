#!/usr/bin/env bun
import { $, file } from "bun"
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"

const packageDirectory = path.resolve(import.meta.dir, "..")
const repositoryDirectory = path.resolve(packageDirectory, "../..")
const version = process.env.KILO_VERSION ?? (await Bun.file(path.join(packageDirectory, "package.json")).json()).version
const payloadDirectory = path.join(packageDirectory, "payload")
const outputDirectory = path.join(packageDirectory, "out")
const iconSource = path.join(repositoryDirectory, "packages/kilo-vscode/assets/icons/logo-outline-black.png")
const iconDestination = path.join(packageDirectory, "assets/logo-outline-black.png")

const payloads = [
  {
    source: path.join(
      repositoryDirectory,
      "packages/kilo-vscode-remote-controller/out/kilo-remote-agent-controller-win32-x64.vsix",
    ),
    destination: "kilo-remote-agent-controller-win32-x64.vsix",
  },
  {
    source: path.join(
      repositoryDirectory,
      "packages/kilo-vscode-remote-controller/out/kilo-remote-agent-controller-linux-x64.vsix",
    ),
    destination: "kilo-remote-agent-controller-linux-x64.vsix",
  },
  {
    source: path.join(
      repositoryDirectory,
      "packages/kilo-vscode-remote-controller/out/kilo-remote-agent-controller-darwin-x64.vsix",
    ),
    destination: "kilo-remote-agent-controller-darwin-x64.vsix",
  },
  {
    source: path.join(
      repositoryDirectory,
      "packages/kilo-vscode-remote-controller/out/kilo-remote-agent-controller-darwin-arm64.vsix",
    ),
    destination: "kilo-remote-agent-controller-darwin-arm64.vsix",
  },
  {
    source: path.join(repositoryDirectory, "packages/kilo-vscode/out/kilo-remote-agent-linux-x64.vsix"),
    destination: "kilo-remote-agent-linux-x64.vsix",
  },
  {
    source: path.join(
      repositoryDirectory,
      "packages/kilo-vscode-remote-worker/out/kilo-remote-agent-worker-linux-x64.vsix",
    ),
    destination: "kilo-remote-agent-worker-linux-x64.vsix",
  },
] as const

await rm(payloadDirectory, { recursive: true, force: true })
await mkdir(payloadDirectory, { recursive: true })
await mkdir(outputDirectory, { recursive: true })
await mkdir(path.dirname(iconDestination), { recursive: true })
await cp(iconSource, iconDestination)

for (const payload of payloads) {
  if (!(await file(payload.source).exists())) {
    throw new Error(`Installer payload not found: ${payload.source}`)
  }
  await cp(payload.source, path.join(payloadDirectory, payload.destination))
}

const packageJsonPath = path.join(packageDirectory, "package.json")
const packageJson = await Bun.file(packageJsonPath).json()
if (packageJson.version !== version) {
  packageJson.version = version
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
}

const output = path.join(outputDirectory, `kilo-remote-agent-installer-${version}.vsix`)
await $`bun node_modules/.bin/vsce package --no-dependencies --skip-license -o ${output}`.cwd(packageDirectory)
console.log(`Created ${output}`)
