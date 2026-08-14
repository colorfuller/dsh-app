#!/usr/bin/env node
// Assemble the on-disk dsh runtime shipped inside the desktop app.
//
// dsh resolves its plugin bundles from a real node_modules tree, so we
// install its production dependency closure into runtime/ with npm (a flat,
// regular-directory layout that Node can resolve at boot time).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(rootDir, "runtime");
const installedManifest = join(rootDir, "node_modules", "@deepseek-ai", "dsh", "package.json");

if (!existsSync(installedManifest)) {
  console.error("root node_modules/@deepseek-ai/dsh is missing; run `pnpm install` first");
  process.exit(1);
}

const version = JSON.parse(readFileSync(installedManifest, "utf8")).version;
if (typeof version !== "string") {
  console.error("installed @deepseek-ai/dsh has no usable version field");
  process.exit(1);
}

const manifest = {
  name: "dsh-desktop-runtime",
  version: "0.0.0",
  private: true,
  type: "module",
  dependencies: {
    "@deepseek-ai/dsh": version
  }
};

if (existsSync(runtimeDir)) {
  rmSync(runtimeDir, { recursive: true, force: true });
}

mkdirSync(runtimeDir, { recursive: true });
writeFileSync(join(runtimeDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`installing @deepseek-ai/dsh@${version} into runtime/ ...`);
const result = spawnSync(
  "npm",
  ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"],
  {
    cwd: runtimeDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  }
);

if (result.error !== undefined) {
  console.error(`npm failed to start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`npm install exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}

// node-pty ships prebuilt binaries for Windows/macOS only. On Linux npm's
// --ignore-scripts above skips its install hook, so the native pty.node is
// never produced and dsh's subprocess plugin cannot load at boot. Rebuild
// just that package with lifecycle scripts enabled (CI installs
// build-essential, and npm bundles its own node-gyp).
console.log("rebuilding node-pty native module ...");
const rebuildResult = spawnSync(
  "npm",
  ["rebuild", "node-pty", "--no-audit", "--no-fund", "--no-progress"],
  {
    cwd: runtimeDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  }
);
if (rebuildResult.error !== undefined) {
  console.error(`npm rebuild failed to start: ${rebuildResult.error.message}`);
  process.exit(1);
}
if (rebuildResult.status !== 0) {
  console.error(`npm rebuild node-pty exited with status ${rebuildResult.status}`);
  process.exit(rebuildResult.status ?? 1);
}

const binPath = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!existsSync(binPath)) {
  console.error(`runtime install completed but the dsh bin is missing: ${binPath}`);
  process.exit(1);
}

console.log(`runtime ready: ${runtimeDir}`);

const pruneScript = join(rootDir, "scripts", "prune-runtime.mjs");
const pruneResult = spawnSync(process.execPath, [pruneScript], {
  stdio: "inherit",
  shell: process.platform === "win32"
});
if (pruneResult.status !== 0) {
  console.error("runtime pruning failed");
  process.exit(pruneResult.status ?? 1);
}
