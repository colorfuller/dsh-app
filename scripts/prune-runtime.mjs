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
const after = count(runtimeRoot);

console.log(
  `runtime pruned: ${before.files} -> ${after.files} files, ` +
    `${(before.bytes / 1024 / 1024).toFixed(1)} -> ${(after.bytes / 1024 / 1024).toFixed(1)} MB`
);
