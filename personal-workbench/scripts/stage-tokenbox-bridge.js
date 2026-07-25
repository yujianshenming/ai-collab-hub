const fs = require("node:fs");
const path = require("node:path");

const workbenchRoot = path.resolve(__dirname, "..");
const candidates = [
  process.env.TOKENBOX_BRIDGE_BUILD_PATH,
  path.resolve(workbenchRoot, "..", "..", "tokenbox", "src-tauri", "target", "release", "tokenbox-bridge.exe"),
  path.resolve(workbenchRoot, "..", "..", "tokenbox", "src-tauri", "target", "x86_64-pc-windows-gnu", "release", "tokenbox-bridge.exe")
].filter(Boolean);

const source = candidates.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!source) {
  throw new Error([
    "找不到 tokenbox-bridge.exe。",
    "请先运行 npm run build:bridge，或设置 TOKENBOX_BRIDGE_BUILD_PATH 指向已构建的 sidecar。"
  ].join("\n"));
}

const destinationDirectory = path.join(workbenchRoot, "sidecars");
const destination = path.join(destinationDirectory, "tokenbox-bridge.exe");
fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, destination);
console.log(`Staged TokenBox bridge: ${source} -> ${destination}`);
