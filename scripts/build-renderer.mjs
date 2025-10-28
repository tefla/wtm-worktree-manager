#!/usr/bin/env node

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = resolve(__dirname, "..");
const outDir = resolve(rootDir, "dist", "renderer");
const entryFile = resolve(rootDir, "src", "renderer", "index.tsx");

const mode = process.env.NODE_ENV?.toLowerCase() === "production" ? "production" : "development";

async function main() {
  await build({
    entryPoints: [entryFile],
    outfile: resolve(outDir, "index.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    sourcemap: true,
    target: "es2021",
    jsx: "automatic",
    minify: mode === "production",
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode),
    },
    loader: {
      ".png": "file",
      ".svg": "file",
      ".ts": "ts",
      ".tsx": "tsx",
    },
    logLevel: "info"
  });

  console.log("[build-renderer] Renderer bundle built successfully.");
}

main().catch((error) => {
  console.error("[build-renderer] Failed to build renderer bundle.");
  if (error?.stack) {
    console.error(error.stack);
  } else {
    console.error(error);
  }
  process.exit(1);
});
