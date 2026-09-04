const esbuild = require("esbuild")

esbuild
  .build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: true,
    minify: false,
  })
  .catch(() => process.exit(1))
