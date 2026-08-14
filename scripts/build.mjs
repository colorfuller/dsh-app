#!/usr/bin/env node
// End-to-end build: runtime -> pkg core -> Tauri sidecar -> Tauri app.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(rootDir, "runtime");
const coreOutputDir = join(rootDir, "dist-core");
const tauriDir = join(rootDir, "src-tauri");
const binariesDir = join(tauriDir, "binaries");
const npmCliEntry = join(rootDir, "npm-cli", "bin", "npm-cli.js");

const CRITICAL_RUNTIME_FILES = [
  join("node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  join("node_modules", "zod", "index.js"),
  join("node_modules", "yaml", "dist", "index.js"),
  join("node_modules", "ws", "index.js"),
  join("node_modules", "sharp", "package.json")
];

function countFiles(dir) {
  let count = 0;
  const pending = [dir];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const path = join(next, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  return count;
}

/** Fail loudly if a runtime tree is missing anything dsh needs at boot. */
function verifyRuntime(dir, label) {
  const missing = CRITICAL_RUNTIME_FILES.filter((file) => !existsSync(join(dir, file)));
  if (missing.length > 0) {
    throw new Error(`${label} is incomplete; missing: ${missing.join(", ")}`);
  }
}

/** Fail loudly if the bundled npm CLI resource is missing. */
function verifyNpmCli(dir, label) {
  const entry = join(dir, "npm-cli", "bin", "npm-cli.js");
  if (!existsSync(entry)) {
    throw new Error(`${label} is missing the npm CLI at ${entry}`);
  }
}

/** Ensure every source runtime file made it into the bundled tree. */
function verifyBundleContainsSource(sourceDir, bundleDir) {
  const missing = [];
  const pending = [sourceDir];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const sourcePath = join(next, entry.name);
      const relativePath = sourcePath.slice(sourceDir.length + 1);
      if (entry.isDirectory()) {
        pending.push(sourcePath);
      } else if (entry.isFile() && !existsSync(join(bundleDir, relativePath))) {
        missing.push(relativePath);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `bundled runtime is missing ${missing.length} source file(s); first: ${missing.slice(0, 10).join(", ")}`
    );
  }
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options
  });
  if (result.error !== undefined) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function targetTriple() {
  const arch = process.arch === "x64" ? "x86_64" : "aarch64";
  switch (process.platform) {
    case "win32":
      return `${arch}-pc-windows-msvc`;
    case "darwin":
      return `${arch}-apple-darwin`;
    default:
      return `${arch}-unknown-linux-gnu`;
  }
}

function main() {
  const args = process.argv.slice(2);
  const extraArgs = [...args];
  const bundlesIndex = extraArgs.indexOf("--bundles");
  const bundles = bundlesIndex >= 0 ? extraArgs[bundlesIndex + 1] : undefined;
  if (bundlesIndex >= 0) {
    extraArgs.splice(bundlesIndex, 2);
  }
  const noBundleIndex = extraArgs.indexOf("--no-bundle");
  const noBundle = noBundleIndex >= 0;
  if (noBundleIndex >= 0) {
    extraArgs.splice(noBundleIndex, 1);
  }

  if (!existsSync(join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"))) {
    run(process.execPath, [join(rootDir, "scripts", "prepare-runtime.mjs")]);
  }
  if (!existsSync(npmCliEntry)) {
    run(process.execPath, [join(rootDir, "scripts", "prepare-npm-cli.mjs")]);
  }
  verifyRuntime(runtimeDir, "source runtime");
  verifyNpmCli(rootDir, "source npm-cli");
  // Re-prune even when the runtime was prepared earlier: the AppImage bundler
  // fails on foreign libc native binaries (koffi's musl_x64) inside
  // node_modules, and linuxdeploy has no per-file exclusion knob.
  run(process.execPath, [join(rootDir, "scripts", "prune-runtime.mjs")]);
  run(process.execPath, [join(rootDir, "scripts", "build-core.mjs")]);

  const coreSource = join(coreOutputDir, process.platform === "win32" ? "dsh-core.exe" : "dsh-core");
  if (!existsSync(coreSource)) {
    throw new Error(`core binary missing after build: ${coreSource}`);
  }

  mkdirSync(binariesDir, { recursive: true });
  const sidecarName = process.platform === "win32"
    ? `dsh-core-${targetTriple()}.exe`
    : `dsh-core-${targetTriple()}`;
  cpSync(coreSource, join(binariesDir, sidecarName));

  const tauriArgs = ["build"];
  if (noBundle) {
    tauriArgs.push("--no-bundle");
  } else if (bundles !== undefined) {
    tauriArgs.push("--bundles", bundles);
  }
  tauriArgs.push(...extraArgs);
  run(join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri"), tauriArgs);

  // The bundler copies resources into target/<profile>/runtime. Verify the
  // produced tree matches the source so an incomplete installer cannot ship.
  const bundledRuntimeDir = join(tauriDir, "target", "release", "runtime");
  if (!existsSync(bundledRuntimeDir)) {
    throw new Error(`bundle runtime missing after build: ${bundledRuntimeDir}`);
  }
  verifyRuntime(bundledRuntimeDir, "bundled runtime");
  verifyNpmCli(join(tauriDir, "target", "release"), "bundled npm-cli");
  verifyBundleContainsSource(runtimeDir, bundledRuntimeDir);
  const sourceCount = countFiles(runtimeDir);
  const bundledCount = countFiles(bundledRuntimeDir);
  if (bundledCount > sourceCount) {
    console.warn(
      `bundled runtime has ${bundledCount - sourceCount} stale extra files (harmless; ` +
        "clean the target dir to remove them)"
    );
  }

  console.log("\nbuild complete");
}

main();
