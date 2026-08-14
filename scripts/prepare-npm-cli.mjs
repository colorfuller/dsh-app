#!/usr/bin/env node
// Vendor the npm CLI (and its bundled dependencies) into npm-cli/ so the
// packaged launcher can install @deepseek-ai/dsh straight from the npm
// registry on the user's machine, using the embedded Node runtime.
//
// npm ships as a regular package whose tarball already contains the
// dependencies it needs (bundleDependencies), so copying node_modules/npm
// with symlinks dereferenced is enough to get a runnable CLI.

import { cpSync, existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// pnpm exposes node_modules/npm as a junction into its virtual store; resolve
// the real directory before copying so dereferencing cannot confuse cpSync.
if (!existsSync(join(rootDir, "node_modules", "npm"))) {
  console.error("node_modules/npm is missing; run `pnpm install` first");
  process.exit(1);
}
const sourceDir = realpathSync(join(rootDir, "node_modules", "npm"));
const outputDir = join(rootDir, "npm-cli");
const entry = join(outputDir, "bin", "npm-cli.js");

rmSync(outputDir, { recursive: true, force: true });
cpSync(sourceDir, outputDir, { recursive: true, dereference: true });

if (!existsSync(entry)) {
  console.error(`npm CLI vendored but the entry is missing: ${entry}`);
  process.exit(1);
}

console.log(`npm CLI vendored: ${outputDir}`);
