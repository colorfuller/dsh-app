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
// The dsh web profile prints `dsh web: http://127.0.0.1:<port>` only after
// the server tree has settled and the port is bound, so that line is the
// readiness signal the shell consumes.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const READY_PREFIX = "DSH_READY";
const ERROR_PREFIX = "DSH_ERROR";
const PLAIN_NODE_MARKER = "PKG_INVOKE_NODEJS";

/**
 * Parse the launcher's own flags. Everything after `--` would belong to dsh,
 * but v1 pins the web-profile flags itself and does not forward arbitrary
 * arguments, so an accidental dsh flag cannot change the bind surface.
 */
function parseLauncherArgs(argv) {
  const options = {
    host: process.env.DSH_HOST ?? DEFAULT_HOST,
    port: Number.parseInt(process.env.DSH_PORT ?? String(DEFAULT_PORT), 10),
    open: process.env.DSH_NO_OPEN !== "1"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-open") {
      options.open = false;
    } else if (argument === "--host" && argv[index + 1] !== undefined) {
      options.host = argv[index + 1];
      index += 1;
    } else if (argument === "--port" && argv[index + 1] !== undefined) {
      options.port = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      process.stdout.write(
        [
          "Usage: dsh-core [--no-open] [--host <host>] [--port <port>]",
          "",
          "Start the bundled dsh web UI and report readiness on stdout.",
          "  --no-open        do not open the system browser (the Tauri shell opens it)",
          "  --host <host>    bind host (default: 127.0.0.1)",
          "  --port <port>    listen port; 0 lets the OS pick a free one (default: 0)",
          ""
        ].join("\n")
      );
      process.exit(0);
    } else {
      process.stderr.write(
        `${ERROR_PREFIX} ${JSON.stringify({ message: `unknown launcher option ${JSON.stringify(argument)}` })}\n`
      );
      process.exitCode = 2;
      process.exit(2);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    process.stderr.write(
      `${ERROR_PREFIX} ${JSON.stringify({ message: `--port must be an integer in 0..65535, got ${JSON.stringify(String(options.port))}` })}\n`
    );
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
  const runtimeDir = process.env.DSH_RUNTIME_DIR
    ? resolve(process.env.DSH_RUNTIME_DIR)
    : join(projectRoot(), "runtime");
  const dshBin = resolveDshBin(runtimeDir);

  const child = spawn(
    process.execPath,
    [
      dshBin,
      "web",
      "--host",
      options.host,
      "--port",
      String(options.port)
    ],
    {
      env: {
        ...process.env,
        PKG_EXECPATH: PLAIN_NODE_MARKER
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );

  child.on("error", (error) => {
    process.stderr.write(
      `${ERROR_PREFIX} ${JSON.stringify({ message: `failed to start dsh: ${error.message}` })}\n`
    );
    process.exitCode = 1;
  });

  let opened = false;
  pumpLines(child.stdout, process.stdout, (line) => {
    const match = /^\s*dsh web:\s+(https?:\/\/\S+)/.exec(line);
    if (match === null) return;
    const url = match[1];
    const port = Number.parseInt(new URL(url).port, 10);
    process.stdout.write(
      `${READY_PREFIX} ${JSON.stringify({ state: "ready", url, host: options.host, port })}\n`
    );
    if (options.open && !opened) {
      opened = true;
      openBrowser(url);
    }
  });
  pumpLines(child.stderr, process.stderr, () => {});

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
    process.exitCode = signal === null ? (code ?? 1) : 1;
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${ERROR_PREFIX} ${JSON.stringify({ message })}\n`);
  process.exitCode = 1;
});
