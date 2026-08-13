#!/usr/bin/env node
// Compile the core launcher with @yao-pkg/pkg. The resulting binary embeds a
// Node runtime and src/launcher.js; the dsh runtime stays on disk beside it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(rootDir, "dist-core");
const entry = join(rootDir, "src", "launcher.js");
const pkgBinary = join(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "pkg.cmd" : "pkg"
);

function defaultTarget() {
  const arch = process.arch === "x64" ? "x64" : "arm64";
  switch (process.platform) {
    case "win32":
      return `node22-win-${arch}`;
    case "darwin":
      return `node22-macos-${arch}`;
    default:
      return `node22-linux-${arch}`;
  }
}

const target = process.env.PKG_TARGETS ?? defaultTarget();
const executable = process.platform === "win32" ? "dsh-core.exe" : "dsh-core";
const output = join(outputDir, executable);

if (!existsSync(entry)) {
  console.error(`launcher entry missing: ${entry}`);
  process.exit(1);
}
if (!existsSync(pkgBinary)) {
  console.error(`pkg binary missing: ${pkgBinary}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
if (existsSync(output)) {
  rmSync(output, { force: true });
}

console.log(`compiling ${entry} -> ${output} (target ${target})`);
const result = spawnSync(
  pkgBinary,
  [entry, "--targets", target, "--output", output],
  {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  }
);

if (result.error !== undefined) {
  console.error(`pkg failed to start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`pkg exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log(`core built: ${output}`);
