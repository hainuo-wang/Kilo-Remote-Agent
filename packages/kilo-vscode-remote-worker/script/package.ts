#!/usr/bin/env bun
import { $ } from "bun"
import { chmod, cp, mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

const target = process.env.KILO_REMOTE_WORKER_TARGET ?? "linux-x64"
const targetToCliDirectory: Record<string, string> = {
  "linux-x64": "cli-linux-x64",
  "linux-arm64": "cli-linux-arm64",
  "alpine-x64": "cli-linux-x64-musl",
  "alpine-arm64": "cli-linux-arm64-musl",
}
const cliDirectory = targetToCliDirectory[target]
if (!cliDirectory) {
  throw new Error(`Unsupported remote worker target: ${target}`)
}

const packageDirectory = dirname(import.meta.dir)
const source = join(packageDirectory, "..", "opencode", "dist", "@kilocode", cliDirectory, "bin", "kilo")
const destination = join(packageDirectory, "bin", "kilo")
const iconSource = join(packageDirectory, "..", "kilo-vscode", "assets", "icons", "logo-outline-black.png")
const iconDestination = join(packageDirectory, "assets", "logo-outline-black.png")
const packageJsonPath = join(packageDirectory, "package.json")
const packageJson = await Bun.file(packageJsonPath).json()
const version = process.env.KILO_VERSION ?? packageJson.version

if (packageJson.version !== version) {
  packageJson.version = version
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
}

await rm(join(packageDirectory, "bin"), { recursive: true, force: true })
await mkdir(dirname(destination), { recursive: true })
await mkdir(dirname(iconDestination), { recursive: true })
await cp(iconSource, iconDestination)

try {
  await cp(source, destination)
} catch {
  throw new Error(
    `Remote worker CLI not found at ${source}. Build the ${cliDirectory} opencode artifact first, or set kilo-code.remoteWorker.cliPath on the remote host.`,
  )
}
await chmod(destination, 0o755)
console.log(`Copied ${source} -> ${destination}`)

if (process.argv.includes("--package")) {
  const output = join(packageDirectory, "out", `kilo-remote-agent-worker-${target}.vsix`)
  await mkdir(dirname(output), { recursive: true })
  await $`bunx vsce package --no-dependencies --skip-license --target ${target} -o ${output}`.cwd(packageDirectory)
  console.log(`Created ${output}`)
}
