#!/usr/bin/env bun
import { $ } from "bun"
import { cp, mkdir } from "node:fs/promises"
import path from "node:path"

const packageDirectory = path.resolve(import.meta.dir, "..")
const repositoryDirectory = path.resolve(packageDirectory, "../..")
const packageJsonPath = path.join(packageDirectory, "package.json")
const packageJson = await Bun.file(packageJsonPath).json()
const version = process.env.KILO_VERSION ?? packageJson.version
const iconSource = path.join(repositoryDirectory, "packages/kilo-vscode/assets/icons/logo-outline-black.png")
const iconDestination = path.join(packageDirectory, "assets/logo-outline-black.png")

if (packageJson.version !== version) {
  packageJson.version = version
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n")
}

const outputDirectory = path.join(packageDirectory, "out")
await mkdir(outputDirectory, { recursive: true })
await mkdir(path.dirname(iconDestination), { recursive: true })
await cp(iconSource, iconDestination)

const output = path.join(outputDirectory, `kilo-remote-agent-pack-${version}.vsix`)
await $`bun node_modules/.bin/vsce package --no-dependencies --skip-license -o ${output}`.cwd(packageDirectory)
console.log(`Created ${output}`)
