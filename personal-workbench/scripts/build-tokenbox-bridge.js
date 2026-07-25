"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tokenboxManifest = path.resolve(__dirname, "..", "..", "..", "tokenbox", "src-tauri", "Cargo.toml");
const passthrough = process.argv.slice(2);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: path.dirname(tokenboxManifest),
    stdio: "inherit",
    windowsHide: true,
    ...options
  });
}

function commandExists(command) {
  const result = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function findGnuToolchain() {
  if (process.env.TOKENBOX_RUST_TOOLCHAIN) return process.env.TOKENBOX_RUST_TOOLCHAIN;
  const result = spawnSync("rustup", ["toolchain", "list"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "";
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .find((name) => name && name.endsWith("-x86_64-pc-windows-gnu")) || "";
}

function findGccBin(root, depth = 0) {
  if (!root || !fs.existsSync(root)) return "";
  const direct = path.join(root, "x86_64-w64-mingw32-gcc.exe");
  if (fs.existsSync(direct)) return root;
  if (depth >= 5) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const found = findGccBin(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return "";
}

function findMingwBin() {
  const roots = [];
  if (process.env.TOKENBOX_MINGW_BIN) roots.push(process.env.TOKENBOX_MINGW_BIN);
  const packagesRoot = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    const packageDirs = fs.readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /WinLibs|LLVM-MinGW/i.test(entry.name))
      .sort((left, right) => Number(/WinLibs/i.test(right.name)) - Number(/WinLibs/i.test(left.name)))
      .map((entry) => path.join(packagesRoot, entry.name));
    roots.push(...packageDirs);
  } catch {}
  for (const root of roots) {
    const found = findGccBin(root);
    if (found) return found;
  }
  return "";
}

function build() {
  if (!fs.existsSync(tokenboxManifest)) {
    throw new Error(`TokenBox manifest not found: ${tokenboxManifest}`);
  }
  const baseArgs = ["build", "--manifest-path", tokenboxManifest, "--release", ...passthrough];

  if (process.platform !== "win32" || commandExists("link.exe")) {
    return run("cargo", baseArgs);
  }

  const toolchain = findGnuToolchain();
  const mingwBin = findMingwBin();
  if (!toolchain || !mingwBin) {
    throw new Error("GNU Rust toolchain and MinGW compiler are required when MSVC link.exe is not on PATH");
  }

  const env = { ...process.env, PATH: `${mingwBin}${path.delimiter}${process.env.PATH || ""}` };
  return run("rustup", ["run", toolchain, "cargo", ...baseArgs, "--target", "x86_64-pc-windows-gnu"], { env });
}

try {
  const result = build();
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`TokenBox bridge build failed: ${error?.message || error}`);
  process.exitCode = 1;
}
