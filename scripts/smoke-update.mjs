#!/usr/bin/env node
// End-to-end smoke test for the npm-direct runtime auto-update:
//  1. starts a local fake npm registry serving @deepseek-ai/dsh@9.9.9;
//  2. runs the launcher with DSH_HOME pointing at a temp dir;
//  3. expects it to install 9.9.9 from the fake registry, write the
//     `current` pointer after readiness, and skip the update on a second run.
//
// No real network access is used: npm_config_cache is also redirected so the
// whole test stays inside its temp directory.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_VERSION = "9.9.9";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useCore = process.env.DSH_SMOKE_CORE !== undefined;
const launcher = useCore
  ? resolve(process.env.DSH_SMOKE_CORE)
  : join(rootDir, "src", "launcher.js");

function fail(message) {
  console.error(`smoke update FAILED: ${message}`);
  process.exitCode = 1;
}

function runTar(root, args) {
  const result = spawnSync("tar", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar exited ${result.status}: ${result.stderr ?? result.stdout}`);
  }
}

function runLauncher(env, cwd, onLine, onErr) {
  const command = useCore ? launcher : process.execPath;
  const args = useCore ? ["--no-open", "--port", "0"] : [launcher, "--no-open", "--port", "0"];
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
  });
  let errorBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errorBuffer += chunk;
    let newline;
    while ((newline = errorBuffer.indexOf("\n")) >= 0) {
      const line = errorBuffer.slice(0, newline);
      errorBuffer = errorBuffer.slice(newline + 1);
      onErr(line);
    }
  });
  return child;
}

function killTree(child) {
  try {
    child.kill();
  } catch {
    // Fall through to the platform kill below.
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function waitExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function waitForReady(lines, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = lines.find((entry) => entry.startsWith("DSH_READY "));
    if (line !== undefined) return line;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`no DSH_READY within ${timeoutMs}ms`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-update-smoke-"));
  let server;
  let launcherChild;
  try {
    // Build a minimal fake @deepseek-ai/dsh package and pack it.
    const packageRoot = join(tmp, "pack");
    const packageDir = join(packageRoot, "package");
    mkdirSync(join(packageDir, "lib"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: "@deepseek-ai/dsh",
          version: FAKE_VERSION,
          type: "module",
          bin: { dsh: "lib/bin.js" }
        },
        null,
        2
      ) + "\n"
    );
    writeFileSync(
      join(packageDir, "lib", "bin.js"),
      [
        "const args = process.argv.slice(2);",
        `if (args.includes("--version")) { process.stdout.write(${JSON.stringify(FAKE_VERSION + "\n")}); process.exit(0); }`,
        "else if (args.includes(\"web\")) {",
        '  const host = args[args.indexOf("--host") + 1] ?? "127.0.0.1";',
        '  const port = args[args.indexOf("--port") + 1] ?? "0";',
        "  process.stdout.write(`dsh web: http://${host}:${port}\\n`);",
        "}",
        "setTimeout(() => process.exit(0), 30_000);",
        ""
      ].join("\n")
    );
    const tarballPath = join(tmp, `dsh-${FAKE_VERSION}.tgz`);
    runTar(packageRoot, ["-czf", tarballPath, "package"]);
    const tarball = readFileSync(tarballPath);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

    // Serve the registry metadata + tarball over loopback.
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      // npm encodes scoped package names in registry requests; decode so one
      // handler covers both "@deepseek-ai/dsh" and "%40deepseek-ai%2fdsh".
      const path = decodeURIComponent(url.pathname);
      const dist = {
        tarball: `http://127.0.0.1:${server.address().port}/dsh-${FAKE_VERSION}.tgz`,
        integrity
      };
      if (path === "/@deepseek-ai/dsh/latest") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ name: "@deepseek-ai/dsh", version: FAKE_VERSION, dist }) + "\n"
        );
      } else if (path === "/@deepseek-ai/dsh") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            name: "@deepseek-ai/dsh",
            "dist-tags": { latest: FAKE_VERSION },
            versions: {
              [FAKE_VERSION]: {
                name: "@deepseek-ai/dsh",
                version: FAKE_VERSION,
                dist,
                dependencies: {}
              }
            }
          }) + "\n"
        );
      } else if (path === `/dsh-${FAKE_VERSION}.tgz`) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(tarball);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const registry = `http://127.0.0.1:${server.address().port}`;

    const home = join(tmp, "dsh-home");
    const env = {
      DSH_NPM_REGISTRY: registry,
      DSH_HOME: home,
      DSH_NO_AUTO_UPDATE: "",
      DSH_UPDATE_CHECK_INTERVAL_MINUTES: "0",
      npm_config_cache: join(tmp, "npm-cache")
    };
    if (useCore) env.DSH_RESOURCE_DIR = rootDir;

    // First run: expect check -> install -> ready.
    const firstLines = [];
    const firstErrors = [];
    launcherChild = runLauncher(env, tmp, (line) => firstLines.push(line), (line) => firstErrors.push(line));
    let firstReady;
    try {
      firstReady = await waitForReady(firstLines, 120_000);
    } catch (error) {
      killTree(launcherChild);
      console.error("launcher stdout:\n" + firstLines.join("\n"));
      console.error("launcher stderr:\n" + firstErrors.join("\n"));
      throw error;
    }
    if (!firstReady.includes(`"url":"http://127.0.0.1:`)) {
      killTree(launcherChild);
      throw new Error(`unexpected DSH_READY payload: ${firstReady}`);
    }
    // The update install now happens in the background after readiness; wait
    // for the current pointer to be promoted before asserting on it.
    const installedBin = join(
      home,
      "runtime",
      FAKE_VERSION,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js"
    );
    const installDeadline = Date.now() + 90_000;
    let pointer = "";
    while (Date.now() < installDeadline) {
      if (existsSync(installedBin)) {
        try {
          pointer = readFileSync(join(home, "runtime", "current"), "utf8").trim();
        } catch {
          pointer = "";
        }
        if (pointer === FAKE_VERSION) break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    if (!existsSync(installedBin)) {
      killTree(launcherChild);
      console.error("launcher stdout:\n" + firstLines.join("\n"));
      console.error("launcher stderr:\n" + firstErrors.join("\n"));
      throw new Error(`installed runtime missing: ${installedBin}`);
    }
    if (pointer !== FAKE_VERSION) {
      killTree(launcherChild);
      throw new Error(`current pointer is ${JSON.stringify(pointer)}, expected ${FAKE_VERSION}`);
    }
    const statuses = firstLines
      .filter((line) => line.startsWith("DSH_STATUS "))
      .map((line) => JSON.parse(line.slice("DSH_STATUS ".length)).state);
    for (const expected of ["checking-update", "updating", "update-installed"]) {
      if (!statuses.includes(expected)) {
        killTree(launcherChild);
        console.error("launcher stdout:\n" + firstLines.join("\n"));
        console.error("launcher stderr:\n" + firstErrors.join("\n"));
        throw new Error(`first run never reported ${expected}; saw ${statuses.join(", ")}`);
      }
    }
    killTree(launcherChild);
    await waitExit(launcherChild);
    launcherChild = undefined;

    // Second run: the pointer makes the launcher reuse 9.9.9 and skip.
    const secondLines = [];
    const secondErrors = [];
    launcherChild = runLauncher(env, tmp, (line) => secondLines.push(line), (line) => secondErrors.push(line));
    let secondReady;
    try {
      secondReady = await waitForReady(secondLines, 120_000);
    } catch (error) {
      killTree(launcherChild);
      console.error("launcher stdout:\n" + secondLines.join("\n"));
      console.error("launcher stderr:\n" + secondErrors.join("\n"));
      throw error;
    }
    if (!secondReady.includes(`"url":"http://127.0.0.1:`)) {
      killTree(launcherChild);
      throw new Error(`second run failed: ${secondReady}`);
    }
    const skipDeadline = Date.now() + 15_000;
    let secondStatuses = [];
    while (Date.now() < skipDeadline) {
      secondStatuses = secondLines
        .filter((line) => line.startsWith("DSH_STATUS "))
        .map((line) => JSON.parse(line.slice("DSH_STATUS ".length)).state);
      if (secondStatuses.includes("update-skipped")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    if (!secondStatuses.includes("update-skipped")) {
      killTree(launcherChild);
      console.error("launcher stdout:\n" + secondLines.join("\n"));
      console.error("launcher stderr:\n" + secondErrors.join("\n"));
      throw new Error(`second run did not skip the update; saw ${secondStatuses.join(", ")}`);
    }
    killTree(launcherChild);
    await waitExit(launcherChild);
    launcherChild = undefined;

    console.log(`smoke update PASSED (first run installed ${FAKE_VERSION}, second run skipped)`);
  } catch (error) {
    if (launcherChild !== undefined) killTree(launcherChild);
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (server !== undefined) server.close();
    if (launcherChild !== undefined) {
      await waitExit(launcherChild);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      }
    }
  }
}

main();
