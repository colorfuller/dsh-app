#!/usr/bin/env node
// Regenerate all platform icons from assets/icon.svg plus the theme-adaptive
// tray icons (black for light themes, white for dark themes). Everything is
// written to src-tauri/icons, which is gitignored and never committed.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIcon = join(rootDir, "assets", "icon.svg");
const iconsDir = join(rootDir, "src-tauri", "icons");
const tauriCli = join(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri"
);

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error !== undefined) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

/// Decode a small, non-interlaced 8-bit RGBA PNG into raw RGBA bytes using
/// only Node's built-in zlib. The Tauri icon generator always emits this
/// format for its PNG outputs.
function pngToRgba(filePath) {
  const data = readFileSync(filePath);
  if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${filePath} is not a PNG file`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`${filePath}: expected 8-bit RGBA, non-interlaced PNG`);
  }

  const channels = 4;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rgba.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? rgba[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += (left + up) >> 1;
          break;
        case 4: {
          const predictor = left + up - upLeft;
          const pa = Math.abs(predictor - left);
          const pb = Math.abs(predictor - up);
          const pc = Math.abs(predictor - upLeft);
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new Error(`${filePath}: invalid PNG filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }
  return rgba;
}

// 1. The full platform icon set (ico/png/icns/android/ios), as before.
run(tauriCli, ["icon", sourceIcon]);

// 2. Tray variants: black whale for light themes, white for dark themes.
const temp = mkdtempSync(join(tmpdir(), "dsh-icons-"));
try {
  const whiteSvg = join(temp, "icon-white.svg");
  const svg = readFileSync(sourceIcon, "utf8")
    .replace('fill="#000"', 'fill="#fff"')
    .replace(/\s*<style>[\s\S]*?<\/style>/, "");
  writeFileSync(whiteSvg, svg, "utf8");

  const lightDir = join(temp, "light");
  const darkDir = join(temp, "dark");
  run(tauriCli, ["icon", sourceIcon, "-o", lightDir]);
  run(tauriCli, ["icon", whiteSvg, "-o", darkDir]);

  mkdirSync(iconsDir, { recursive: true });
  cpSync(join(lightDir, "64x64.png"), join(iconsDir, "tray-light.png"));
  cpSync(join(darkDir, "64x64.png"), join(iconsDir, "tray-dark.png"));
  writeFileSync(
    join(iconsDir, "tray-light.rgba"),
    pngToRgba(join(iconsDir, "tray-light.png"))
  );
  writeFileSync(
    join(iconsDir, "tray-dark.rgba"),
    pngToRgba(join(iconsDir, "tray-dark.png"))
  );
  console.log(
    "tray icons generated: tray-light (black) / tray-dark (white), with raw RGBA for embedding"
  );

  // 3. macOS Dock icon: macOS app icons conventionally sit on a rounded tile
  // instead of a bare transparent glyph. Derive a DeepSeek-blue rounded
  // square with the white whale, and regenerate only the .icns from it.
  const whalePath = svg.match(/\sd="([^"]+)"/)?.[1];
  if (!whalePath) {
    throw new Error(`could not extract whale path from ${sourceIcon}`);
  }
  const macosSvg = join(temp, "icon-macos.svg");
  writeFileSync(
    macosSvg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="229" fill="#3964FE"/><g transform="translate(192,192) scale(12.8)"><path d="${whalePath}" fill="#fff"/></g></svg>`,
    "utf8"
  );
  const macosDir = join(temp, "macos");
  run(tauriCli, ["icon", macosSvg, "-o", macosDir]);
  cpSync(join(macosDir, "icon.icns"), join(iconsDir, "icon.icns"));
  console.log("macOS Dock icon generated: icon.icns (blue tile + white whale)");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
