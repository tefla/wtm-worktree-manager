#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const requireFromHere = createRequire(__filename);

const forceRebuild = process.argv.includes("--force");

async function ensureNodePty() {
  let electronVersion;
  try {
    ({ version: electronVersion } = requireFromHere("electron/package.json"));
  } catch (error) {
    console.error("[ensure-node-pty] Unable to resolve the local Electron version. Has `npm install` completed?");
    throw error;
  }

  let nodePtyRoot;
  try {
    nodePtyRoot = path.dirname(requireFromHere.resolve("node-pty/package.json"));
  } catch (error) {
    console.error("[ensure-node-pty] node-pty is not installed. Run `npm install` first.");
    throw error;
  }

  const binaryPath = path.join(nodePtyRoot, "build", "Release", "pty.node");
  const markerPath = path.join(nodePtyRoot, ".electron-rebuild-version");

  if (!forceRebuild) {
    const hasBinary = fs.existsSync(binaryPath);
    const markerVersion = fs.existsSync(markerPath)
      ? fs.readFileSync(markerPath, "utf8").trim()
      : null;

    if (hasBinary && markerVersion === electronVersion) {
      return;
    }

    if (!hasBinary) {
      console.warn("[ensure-node-pty] Missing node-pty native binary, rebuilding…");
    } else if (markerVersion !== electronVersion) {
      console.warn(
        `[ensure-node-pty] node-pty was last built for Electron ${markerVersion ?? "unknown"}, rebuilding for ${electronVersion}…`,
      );
    }
  } else {
    console.warn("[ensure-node-pty] Forcing node-pty rebuild…");
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "rebuild",
    "node-pty",
    "--runtime=electron",
    `--target=${electronVersion}`,
    "--disturl=https://electronjs.org/headers",
  ];

  console.log(`[ensure-node-pty] Rebuilding node-pty for Electron ${electronVersion}…`);

  await new Promise((resolve, reject) => {
    const child = spawn(npmCommand, args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`node-pty rebuild failed with exit code ${code}`));
      }
    });
  });

  try {
    fs.writeFileSync(markerPath, `${electronVersion}\n`, "utf8");
  } catch (error) {
    console.warn("[ensure-node-pty] Unable to write rebuild marker file.", error);
  }

  console.log("[ensure-node-pty] node-pty rebuild completed successfully.");
}

ensureNodePty().catch((error) => {
  console.error("[ensure-node-pty] Failed to ensure node-pty is rebuilt.");
  if (error?.stack) {
    console.error(error.stack);
  } else {
    console.error(error);
  }
  process.exit(1);
});
