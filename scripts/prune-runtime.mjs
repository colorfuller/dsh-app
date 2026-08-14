#!/usr/bin/env node
// Remove files that are never needed by a running dsh instance: debug
// symbols, source maps, TypeScript/C++ sources, and documentation. This
// shrinks the bundled runtime from ~33k files to roughly a third, which makes
// Tauri's resource copy and NSIS packaging much faster.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = join(rootDir, "runtime", "node_modules");

const REMOVE_EXTENSIONS = new Set([
  ".pdb",
  ".map",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".mtsx",
  ".ctsx",
  ".cc",
  ".cpp",
  ".h",
  ".hh",
  ".md",
  ".txt",
  ".tsbuildinfo"
]);

const REMOVE_BASENAMES = new Set([
  "license",
  "licence",
  "copying",
  "readme",
  "readme.md",
  "changelog",
  "changes",
  "history",
  "notice",
  "authors",
  "contributors"
]);

// Koffi ships one native directory per supported OS/libc inside the same
// platform package (e.g. linux_x64/ and musl_x64/ in koffi-linux-x64).
// linuxdeploy scans every ELF file in the AppImage AppDir and aborts when it
// cannot resolve a libc variant it does not ship with, so keep only the
// variant this host can actually run.
function nativeDirPrefixes() {
  const arch = process.arch;
  if (process.platform === "linux") {
    const report = process.report.getReport();
    const libc = report?.header?.glibcVersionRuntime ? "linux" : "musl";
    return new Set([`${libc}_${arch}`]);
  }
  return new Set([`${process.platform}_${arch}`]);
}

function pruneForeignNativeDirs() {
  const koromixDir = join(runtimeRoot, "@koromix");
  let entries;
  try {
    entries = readdirSync(koromixDir, { withFileTypes: true });
  } catch {
    return;
  }

  const keep = nativeDirPrefixes();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("koffi-")) {
      continue;
    }

    const packageDir = join(koromixDir, entry.name);
    let subEntries;
    try {
      subEntries = readdirSync(packageDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sub of subEntries) {
      if (!sub.isDirectory() || keep.has(sub.name)) {
        continue;
      }
      // Only remove directories that look like native ABI dirs (e.g.
      // musl_x64, darwin_arm64); never touch package metadata folders.
      if (/^(win32|darwin|linux|musl|freebsd|openbsd|netbsd|android|ios|sunos)_[a-z0-9]+$/.test(sub.name)) {
        const fullPath = join(packageDir, sub.name);
        rmSync(fullPath, { recursive: true, force: true });
        console.log(`removed foreign native dir: ${fullPath}`);
      }
    }
  }
}

function isRemovable(name) {
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  const basename = dot >= 0 ? name.slice(0, dot).toLowerCase() : name.toLowerCase();
  return REMOVE_EXTENSIONS.has(extension) || REMOVE_BASENAMES.has(basename);
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else if (entry.isFile() && isRemovable(entry.name)) {
      rmSync(path, { force: true });
    }
  }
}

function count(dir) {
  let files = 0;
  let bytes = 0;
  const pending = [dir];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let entries;
    try {
      entries = readdirSync(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(next, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(path).size;
        } catch {
          // A concurrently deleted file simply stops contributing to totals.
        }
      }
    }
  }
  return { files, bytes };
}

const before = count(runtimeRoot);
walk(runtimeRoot);
pruneForeignNativeDirs();
const after = count(runtimeRoot);

console.log(
  `runtime pruned: ${before.files} -> ${after.files} files, ` +
    `${(before.bytes / 1024 / 1024).toFixed(1)} -> ${(after.bytes / 1024 / 1024).toFixed(1)} MB`
);
