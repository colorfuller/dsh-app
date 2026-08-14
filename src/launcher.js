#!/usr/bin/env node
// dsh-desktop core launcher.
//
// This file is the entry point bundled by @yao-pkg/pkg, so it embeds a Node
// runtime. pkg's snapshot cannot `import()` an external ESM file, so the core
// runs as a supervisor: it re-executes itself in pkg's "plain Node" mode
// (PKG_EXECPATH=PKG_INVOKE_NODEJS) with the on-disk dsh bin.js as argv[1].
// The same code path works in source mode where process.execPath is plain
// node.exe, and the environment marker is simply ignored.
//
// Runtime auto-update: unless disabled, the launcher asks the npm registry
// for the latest @deepseek-ai/dsh and installs it (using the npm CLI shipped
// as a resource) into $DSH_HOME/runtime/<version>. A `current` pointer keeps
// the last-known-good version, failed versions are marked and skipped, and
// any update failure falls back to the runtime bundled with the app.
//
// The dsh web profile prints `dsh web: http://127.0.0.1:<port>` only after
// the server tree has settled and the port is bound, so that line is the
// readiness signal the shell consumes.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const READY_PREFIX = "DSH_READY";
const ERROR_PREFIX = "DSH_ERROR";
const STATUS_PREFIX = "DSH_STATUS";
const PLAIN_NODE_MARKER = "PKG_INVOKE_NODEJS";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const NPM_PACKAGE = "@deepseek-ai/dsh";
const RUNTIME_DIR_NAME = "runtime";
const CURRENT_POINTER = "current";
const FAILED_MARKER = ".failed";
const NPM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const UPDATE_CHECK_INTERVAL_DEFAULT_MS = 6 * 60 * 60 * 1000;
const UPDATE_STAMP_FILE = ".last-update-check";
const STALE_TMP_MAX_AGE_MS = 60 * 60 * 1000;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 30;

/** Best-effort log file under the resolved dsh home; set once home is known. */
let coreLogPath = null;

function appendLog(line) {
  if (coreLogPath === null) return;
  try {
    mkdirSync(dirname(coreLogPath), { recursive: true });
    const stats = existsSync(coreLogPath) ? statSync(coreLogPath) : null;
    if (stats !== null && stats.size > LOG_MAX_BYTES) {
      try {
        renameSync(coreLogPath, `${coreLogPath}.1`);
      } catch {
        // Rotation is best-effort; keep appending if the rename fails.
      }
    }
    appendFileSync(coreLogPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never take the launcher down.
  }
}

/**
 * Parse the launcher's own flags. Everything after `--` would belong to dsh,
 * but v1 pins the web-profile flags itself and does not forward arbitrary
 * arguments, so an accidental dsh flag cannot change the bind surface.
 */
function parseLauncherArgs(argv) {
  const options = {
    host: process.env.DSH_HOST ?? DEFAULT_HOST,
    port: Number.parseInt(process.env.DSH_PORT ?? String(DEFAULT_PORT), 10),
    open: process.env.DSH_NO_OPEN !== "1",
    autoUpdate: process.env.DSH_NO_AUTO_UPDATE !== "1"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-open") {
      options.open = false;
    } else if (argument === "--no-update") {
      options.autoUpdate = false;
    } else if (argument === "--host" && argv[index + 1] !== undefined) {
      options.host = argv[index + 1];
      index += 1;
    } else if (argument === "--port" && argv[index + 1] !== undefined) {
      options.port = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      process.stdout.write(
        [
          "Usage: dsh-core [--no-open] [--no-update] [--host <host>] [--port <port>]",
          "",
          "Start the bundled dsh web UI and report readiness on stdout.",
          "  --no-open        do not open the system browser (the Tauri shell opens it)",
          "  --no-update      skip the npm runtime auto-update check",
          "  --host <host>    bind host (default: 127.0.0.1)",
          "  --port <port>    listen port; 0 lets the OS pick a free one (default: 0)",
          ""
        ].join("\n")
      );
      process.exit(0);
    } else {
      emitError(`unknown launcher option ${JSON.stringify(argument)}`);
      process.exitCode = 2;
      process.exit(2);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    emitError(`--port must be an integer in 0..65535, got ${JSON.stringify(String(options.port))}`);
    process.exit(2);
  }

  return options;
}

/** Directory holding this project in source mode, or beside the exe in pkg mode. */
function projectRoot() {
  if (typeof process.pkg !== "undefined") {
    return dirname(process.execPath);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Emit a machine-readable status payload for the Tauri shell to render. */
function status(payload) {
  const line = `${STATUS_PREFIX} ${JSON.stringify(payload)}`;
  process.stdout.write(`${line}\n`);
  appendLog(line);
}

/** Emit a DSH_ERROR payload (with the log path) and record it locally. */
function emitError(message) {
  const payload = { message };
  if (coreLogPath !== null) payload.log = coreLogPath;
  const line = `${ERROR_PREFIX} ${JSON.stringify(payload)}`;
  process.stderr.write(`${line}\n`);
  appendLog(line);
}

/** Expand a leading ~ in a user-supplied path, like dsh itself does. */
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Strip a Windows verbatim (\\?\) prefix, which breaks child argv parsing. */
function normalizePath(input) {
  if (typeof input !== "string") return input;
  if (input.startsWith("\\\\?\\UNC\\")) return `\\${input.slice(7)}`;
  if (input.startsWith("\\\\?\\")) return input.slice(4);
  return input;
}

/** App-owned data directory used when the default dsh home is not writable. */
function appDataDshHome() {
  const appData = normalizePath(process.env.DSH_APP_DATA_DIR)?.trim();
  if (appData !== undefined && appData.length > 0) {
    return join(appData, "dsh-home");
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA !== undefined) {
    return join(process.env.LOCALAPPDATA, "dsh-app", "dsh-home");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "dsh-app", "dsh-home");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg.length > 0) return join(xdg, "dsh-app", "dsh-home");
  return join(homedir(), ".local", "share", "dsh-app", "dsh-home");
}

function isWritableDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, "ok\n");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve $DSH_HOME (default ~/.dsh). If the default is not writable, fall
 * back to the app data directory, then to the OS temp directory, so a locked
 * profile cannot prevent the app from starting.
 */
function resolveDshHome(env) {
  const explicit = (env.DSH_HOME ?? "").trim();
  if (explicit.length > 0) return resolve(expandHome(explicit));
  const defaultHome = join(homedir(), ".dsh");
  if (isWritableDir(defaultHome)) return defaultHome;
  for (const fallback of [appDataDshHome(), join(tmpdir(), "dsh-app-dsh-home")]) {
    if (isWritableDir(fallback)) {
      status({ state: "home-fallback", home: fallback });
      return fallback;
    }
  }
  return defaultHome;
}

/** Minimal semver parser (numeric identifiers + prerelease). */
function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(raw).trim()
  );
  if (match === null) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] === undefined ? null : match[4].split(".")
  };
}

/** Compare two semver strings; a release is greater than any prerelease. */
function compareSemver(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return String(a).localeCompare(String(b));
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  const prA = pa.prerelease ?? [];
  const prB = pb.prerelease ?? [];
  if (prA.length === 0 && prB.length === 0) return 0;
  if (prA.length === 0) return 1;
  if (prB.length === 0) return -1;
  const length = Math.max(prA.length, prB.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= prA.length) return -1;
    if (index >= prB.length) return 1;
    const left = prA[index];
    const right = prB[index];
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number.parseInt(left, 10) !== Number.parseInt(right, 10)) {
        return Number.parseInt(left, 10) - Number.parseInt(right, 10);
      }
    } else if (leftNumeric) {
      return -1;
    } else if (rightNumeric) {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** Make a version safe to use as a directory name on every platform. */
function sanitizeVersionName(version) {
  return String(version).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

/** Version of the dsh installation inside a runtime directory, or null. */
function runtimeVersionAt(dir) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, "node_modules", NPM_PACKAGE, "package.json"), "utf8")
    );
    return typeof manifest.version === "string" && parseVersion(manifest.version) !== null
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

function isValidRuntimeDir(dir) {
  return existsSync(join(dir, "node_modules", NPM_PACKAGE, "lib", "bin.js"));
}

/** The runtime directory shipped with the app (resource dir or repo root). */
function bundledRuntimeDir() {
  const candidates = [];
  const resourceDir = normalizePath(process.env.DSH_RESOURCE_DIR);
  if (resourceDir !== undefined) candidates.push(join(resourceDir, RUNTIME_DIR_NAME));
  candidates.push(join(projectRoot(), RUNTIME_DIR_NAME));
  return candidates.find((candidate) => isValidRuntimeDir(candidate)) ?? candidates[0];
}

/** User-installed versions under $DSH_HOME/runtime, newest first. */
function listUserVersions(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && parseVersion(entry.name) !== null)
    .map((entry) => entry.name)
    .sort((a, b) => compareSemver(b, a));
}

/** Pick the newest verified user runtime, honoring the current pointer. */
function pickUserRuntime(root) {
  try {
    const pointer = readFileSync(join(root, CURRENT_POINTER), "utf8").trim();
    const dir = join(root, sanitizeVersionName(pointer));
    if (
      pointer.length > 0 &&
      isValidRuntimeDir(dir) &&
      !existsSync(join(dir, FAILED_MARKER))
    ) {
      return { dir, version: pointer, source: "user" };
    }
  } catch {
    // No pointer yet; fall through to version-directory scan.
  }
  for (const version of listUserVersions(root)) {
    const dir = join(root, sanitizeVersionName(version));
    if (isValidRuntimeDir(dir) && !existsSync(join(dir, FAILED_MARKER))) {
      return { dir, version, source: "user" };
    }
  }
  return null;
}

/** Keep at most two user runtimes: the current one and one previous version. */
function pruneUserRuntimes(root, keepVersion) {
  const versions = listUserVersions(root);
  const previous = versions.find((version) => compareSemver(version, keepVersion) < 0) ?? null;
  const keep = new Set([keepVersion, previous].filter(Boolean));
  const rootPrefix = resolve(root) + sep;
  for (const version of versions) {
    if (keep.has(version)) continue;
    const dir = join(root, sanitizeVersionName(version));
    if (!resolve(dir).startsWith(rootPrefix)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a locked directory is harmless.
    }
  }
}

/** How often the background update check may hit the registry. */
function updateCheckIntervalMs() {
  const raw = process.env.DSH_UPDATE_CHECK_INTERVAL_MINUTES?.trim();
  if (raw !== undefined && raw.length > 0) {
    const minutes = Number.parseInt(raw, 10);
    if (Number.isInteger(minutes) && minutes >= 0) return minutes * 60 * 1000;
  }
  return UPDATE_CHECK_INTERVAL_DEFAULT_MS;
}

function isUpdateCheckDue(userRoot) {
  const interval = updateCheckIntervalMs();
  if (interval === 0) return true;
  try {
    const stats = statSync(join(userRoot, UPDATE_STAMP_FILE));
    return Date.now() - stats.mtimeMs >= interval;
  } catch {
    return true;
  }
}

function stampUpdateCheck(userRoot) {
  try {
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(join(userRoot, UPDATE_STAMP_FILE), `${new Date().toISOString()}\n`);
  } catch {
    // Best-effort.
  }
}

function cleanupStaleTmpDirs(userRoot) {
  if (!existsSync(userRoot)) return;
  for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".tmp-")) continue;
    const dir = join(userRoot, entry.name);
    try {
      const stats = statSync(dir);
      if (Date.now() - stats.mtimeMs > STALE_TMP_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}

/** Check for a newer dsh in the background; the running instance keeps going. */
async function runUpdateCheck({ userRoot, currentVersion }) {
  try {
    cleanupStaleTmpDirs(userRoot);
    if (!isUpdateCheckDue(userRoot)) return;
    const registry = resolveRegistry();
    status({ state: "checking-update", current: currentVersion ?? null });
    let remote;
    try {
      remote = await fetchLatest(registry);
    } finally {
      // Stamp even on failure so an offline machine does not hit the 20s
      // registry timeout on every launch.
      stampUpdateCheck(userRoot);
    }
    const shouldUpdate =
      remote.version !== null &&
      (currentVersion === null || compareSemver(remote.version, currentVersion) > 0);
    if (!shouldUpdate) {
      status({
        state: "update-skipped",
        current: currentVersion ?? null,
        remote: remote.version ?? null
      });
      return;
    }
    status({ state: "updating", from: currentVersion ?? null, to: remote.version });
    const npmCli = resolveNpmCli();
    const result = await installRuntimeVersion({
      root: userRoot,
      version: remote.version,
      npmCli,
      registry
    });
    if (!result.ok) {
      status({ state: "update-failed", message: result.message });
      return;
    }
    // Installed and verified; the next launch picks it up. A boot failure is
    // handled by the `.failed` marker + fallback in the next session.
    try {
      writeFileSync(join(userRoot, CURRENT_POINTER), `${result.version}\n`);
      pruneUserRuntimes(userRoot, result.version);
    } catch {
      // Best-effort; the version scan still finds the new directory.
    }
    status({ state: "update-installed", version: result.version });
  } catch (error) {
    status({
      state: "update-failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

/** npm registry URL, honoring app-level and npm's own configuration. */
function resolveRegistry() {
  const value =
    process.env.DSH_NPM_REGISTRY?.trim() ||
    process.env.npm_config_registry?.trim() ||
    DEFAULT_REGISTRY;
  return value.replace(/\/+$/, "");
}

/** Ask the npm registry for the latest dsh version and its dist metadata. */
async function fetchLatest(registry) {
  const url = `${registry}/${NPM_PACKAGE}/latest`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`npm registry check failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  if (data.name !== undefined && data.name !== NPM_PACKAGE) {
    throw new Error(`unexpected npm package metadata: ${JSON.stringify(data.name)}`);
  }
  if (typeof data.version !== "string" || parseVersion(data.version) === null) {
    throw new Error("npm registry returned an unusable version");
  }
  return {
    version: data.version,
    integrity: data.dist?.integrity ?? null,
    tarball: data.dist?.tarball ?? null
  };
}

/** The npm CLI shipped as an app resource. */
function resolveNpmCli() {
  const candidates = [];
  const resourceDir = normalizePath(process.env.DSH_RESOURCE_DIR);
  if (resourceDir !== undefined) {
    candidates.push(join(resourceDir, "npm-cli", "bin", "npm-cli.js"));
  }
  candidates.push(join(projectRoot(), "npm-cli", "bin", "npm-cli.js"));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      "bundled npm CLI not found; run scripts/prepare-npm-cli.mjs or rebuild the app"
    );
  }
  return found;
}

/** Spawn the embedded Node runtime (plain-node mode in pkg builds). */
function spawnPlainNode(args, options = {}) {
  const env = options.env === undefined ? { ...process.env } : { ...process.env, ...options.env };
  return spawn(process.execPath, args, {
    ...options,
    env: { ...env, PKG_EXECPATH: PLAIN_NODE_MARKER },
    windowsHide: true
  });
}

function spawnSyncPlainNode(args, options = {}) {
  const env = options.env === undefined ? { ...process.env } : { ...process.env, ...options.env };
  return spawnSync(process.execPath, args, {
    ...options,
    env: { ...env, PKG_EXECPATH: PLAIN_NODE_MARKER },
    windowsHide: true
  });
}

/** Run `npm install` for a pinned dsh version inside `cwd`. */
function runNpmInstall(npmCli, cwd, registry) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnPlainNode(
      [
        npmCli,
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-progress",
        "--no-package-lock"
      ],
      {
        cwd,
        env: { npm_config_registry: registry },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      reject(
        new Error(
          `npm install timed out after ${Math.round(NPM_INSTALL_TIMEOUT_MS / 60_000)} minutes`
        )
      );
    }, NPM_INSTALL_TIMEOUT_MS);
    pumpLines(child.stdout, process.stdout, () => {});
    pumpLines(child.stderr, process.stderr, () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) {
        reject(new Error(`npm install terminated by ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`npm install exited with code ${code}`));
      } else {
        resolvePromise();
      }
    });
  });
}

/**
 * Install @deepseek-ai/dsh@version from the npm registry into
 * $DSH_HOME/runtime/<version>, atomically swapping the temp dir in.
 */
async function installRuntimeVersion({ root, version, npmCli, registry }) {
  const safeVersion = sanitizeVersionName(version);
  const tmpDir = join(root, `.tmp-${safeVersion}-${process.pid}-${Date.now()}`);
  const finalDir = join(root, safeVersion);
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify(
        {
          name: "dsh-desktop-runtime",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: { [NPM_PACKAGE]: version }
        },
        null,
        2
      ) + "\n"
    );

    status({ state: "updating", phase: "installing", to: version });
    const heartbeat = setInterval(() => {
      status({ state: "updating", phase: "installing", to: version });
    }, HEARTBEAT_MS);
    try {
      await runNpmInstall(npmCli, tmpDir, registry);
    } finally {
      clearInterval(heartbeat);
    }

    const installedVersion = runtimeVersionAt(tmpDir);
    if (installedVersion !== version) {
      throw new Error(
        `installed dsh version mismatch: expected ${version}, got ${installedVersion ?? "missing"}`
      );
    }
    const probe = spawnSyncPlainNode(
      [join(tmpDir, "node_modules", NPM_PACKAGE, "lib", "bin.js"), "--version"],
      { encoding: "utf8", timeout: 60_000 }
    );
    const probeOutput = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    if (probe.status !== 0 || !probeOutput.includes(version)) {
      throw new Error(`installed dsh --version probe failed (exit ${probe.status})`);
    }

    if (existsSync(finalDir)) {
      rmSync(finalDir, { recursive: true, force: true });
    }
    renameSync(tmpDir, finalDir);
    return { ok: true, dir: finalDir, version };
  } catch (error) {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolve the on-disk dsh installation shipped as an application resource. */
function resolveDshBin(runtimeDir) {
  const candidate = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(candidate)) {
    throw new Error(
      `bundled dsh runtime not found at ${candidate}; rebuild with the runtime included (scripts/prepare-runtime.mjs)`
    );
  }
  return candidate;
}

/** Open a URL with the platform's default browser, detached from this process. */
function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening the browser is best-effort; dsh itself stays healthy.
  }
}

/** Forward a child stream line-by-line, optionally invoking a callback per line. */
function pumpLines(stream, destination, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer.replace(/\r$/, ""));
      buffer = "";
    }
  });
  stream.on("data", (chunk) => {
    // Keep stdout/stderr passthrough independent of line splitting.
    destination.write(chunk);
  });
}

async function main() {
  const options = parseLauncherArgs(process.argv.slice(2));
  const home = resolveDshHome(process.env);
  coreLogPath = join(home, "logs", "core.log");
  appendLog(
    `--- dsh-core starting pid=${process.pid} node=${process.version} args=${JSON.stringify(
      process.argv.slice(2)
    )} ---`
  );
  appendLog(`cwd=${process.cwd()}`);
  appendLog(`env.DSH_RESOURCE_DIR=${process.env.DSH_RESOURCE_DIR ?? ""}`);
  appendLog(`env.DSH_APP_DATA_DIR=${process.env.DSH_APP_DATA_DIR ?? ""}`);
  appendLog(`env.DSH_RUNTIME_DIR=${process.env.DSH_RUNTIME_DIR ?? ""}`);
  appendLog(`env.DSH_HOME=${process.env.DSH_HOME ?? ""}`);
  appendLog(`home=${home}`);
  const userRoot = join(home, RUNTIME_DIR_NAME);
  const explicitRuntime = process.env.DSH_RUNTIME_DIR
    ? resolve(normalizePath(process.env.DSH_RUNTIME_DIR))
    : null;
  const bundled = bundledRuntimeDir();
  const bundledVersion = runtimeVersionAt(bundled);

  let resolved;
  if (explicitRuntime !== null) {
    resolved = { dir: explicitRuntime, version: runtimeVersionAt(explicitRuntime), source: "explicit" };
  } else {
    resolved =
      pickUserRuntime(userRoot) ??
      (bundledVersion !== null ? { dir: bundled, version: bundledVersion, source: "bundled" } : null);
    // No pre-start update check: the current runtime starts immediately and
    // the update check/install runs in the background after readiness.
  }

  if (resolved === null || !isValidRuntimeDir(resolved.dir)) {
    emitError(
      "dsh runtime not found; rebuild with the runtime included (scripts/prepare-runtime.mjs)"
    );
    process.exitCode = 1;
    return;
  }

  const dshBin = resolveDshBin(resolved.dir);
  appendLog(`resolved runtime: ${JSON.stringify(resolved)}`);
  appendLog(`dshBin=${dshBin}`);
  appendLog(
    `spawning child: execPath=${process.execPath} args=${JSON.stringify([
      dshBin,
      "web",
      "--host",
      options.host,
      "--port",
      String(options.port)
    ])}`
  );
  const child = spawnPlainNode(
    [dshBin, "web", "--host", options.host, "--port", String(options.port)],
    {
      env: { DSH_RUNTIME_DIR: resolved.dir, DSH_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let becameReady = false;
  const stderrTail = [];
  const markFailed = () => {
    if (becameReady || resolved.source !== "user") return;
    try {
      writeFileSync(join(resolved.dir, FAILED_MARKER), `${new Date().toISOString()}\n`);
    } catch {
      // Best-effort; the runtime root may be read-only.
    }
  };
  const finalizeVersion = () => {
    if (resolved.source !== "user") return;
    try {
      writeFileSync(join(userRoot, CURRENT_POINTER), `${resolved.version}\n`);
      pruneUserRuntimes(userRoot, resolved.version);
    } catch {
      // Best-effort.
    }
  };

  child.on("error", (error) => {
    markFailed();
    appendLog(`child spawn error: ${error.message}`);
    emitError(`failed to start dsh: ${error.message}`);
    process.exitCode = 1;
  });

  let opened = false;
  pumpLines(child.stdout, process.stdout, (line) => {
    const match = /^\s*dsh web:\s+(https?:\/\/\S+)/.exec(line);
    if (match === null) return;
    const url = match[1];
    const port = Number.parseInt(new URL(url).port, 10);
    becameReady = true;
    finalizeVersion();
    if (options.autoUpdate && resolved.source !== "explicit") {
      runUpdateCheck({ userRoot, currentVersion: resolved.version });
    }
    const readyLine = `${READY_PREFIX} ${JSON.stringify({ state: "ready", url, host: options.host, port })}`;
    process.stdout.write(`${readyLine}\n`);
    appendLog(readyLine);
    if (options.open && !opened) {
      opened = true;
      openBrowser(url);
    }
  });
  pumpLines(child.stderr, process.stderr, (line) => {
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail.shift();
    appendLog(`[err] ${line}`);
  });

  // In dev/CLI use the parent and child share one console group on Windows,
  // so Ctrl+C reaches both; forwarding still covers POSIX and detached shells.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        child.kill();
      }
    });
  }

  child.on("exit", (code, signal) => {
    appendLog(`child exited code=${code ?? "null"} signal=${signal ?? "null"} ready=${becameReady}`);
    if (!becameReady) {
      const tail = stderrTail.slice(-10).join("\n");
      emitError(
        `dsh 进程未就绪即退出（exit code ${code ?? "null"}${
          signal !== null ? `, signal ${signal}` : ""
        }）${tail.length > 0 ? `\n最近输出：\n${tail}` : ""}`
      );
    }
    markFailed();
    process.exitCode = signal === null ? (code ?? 1) : 1;
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  appendLog(`fatal: ${message}`);
  emitError(message);
  process.exitCode = 1;
});
