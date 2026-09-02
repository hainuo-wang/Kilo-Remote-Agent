import { cmd } from "@/cli/cmd/cmd"

export const RemoteWorkerCommand = cmd({
  command: "remote-worker",
  describe: false,
  builder: (yargs) =>
    yargs
      .option("root", {
        type: "string",
        describe: "workspace root served by the remote worker",
      })
      .option("stdio", {
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    if (!args.stdio) throw new Error("remote-worker requires --stdio")
    process.env.KILO_REMOTE_WORKER = "1"
    const { runRemoteWorker } = await import("@/kilocode/remote-worker/server")
    await runRemoteWorker({ root: args.root ?? process.cwd() })
  },
})
