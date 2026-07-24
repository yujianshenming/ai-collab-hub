const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("TokenBox integration keeps the sidecar boundary allowlisted", () => {
  const main = read("main.js");
  const preload = read("preload.js");
  const renderer = read("renderer.js");
  const html = read("index.html");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(main, /function requestTokenboxBridge\(method, params = \{\}\)/);
  assert.match(main, /function normalizeTokenboxFilter\(value\)/);
  assert.match(main, /\["all", "codex", "claude", "claude_code"\]\.includes\(provider\)/);
  assert.match(main, /requestTokenboxBridge\("refresh_dashboard", \{ filter \}\)/);
  assert.match(main, /TOKENBOX_BRIDGE_REQUEST_TIMEOUT_MS = 120000/);
  assert.match(main, /TOKENBOX_BRIDGE_MAX_LINE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(main, /path\.extname\(candidate\)\.toLowerCase\(\) === "\.exe"/);
  assert.doesNotMatch(main, /ipcMain\.handle\("tokenbox:[^"]+",[^\n]*method/);

  assert.match(preload, /getTokenboxStatus: \(\) => ipcRenderer\.invoke\("tokenbox:status"\)/);
  assert.match(preload, /refreshTokenbox: \(filter\) => ipcRenderer\.invoke\("tokenbox:refresh", \{ filter \}\)/);
  assert.match(renderer, /const TOKENBOX_ID = "__tokenbox__"/);
  assert.match(renderer, /window\.workbench\.refreshTokenbox\(tokenboxFilter\(\)\)/);
  assert.match(html, /id="tokenbox-view"/);
  assert.match(html, /id="tokenbox-models-body"/);
  assert.match(html, /id="tokenbox-daily-body"/);

  assert.equal(packageJson.build.extraResources[0].from, "sidecars");
  assert.deepEqual(packageJson.build.extraResources[0].filter, ["tokenbox-bridge.exe"]);
});

test("TokenBox build scripts stage the exact bridge binary", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["build:bridge"], /--bin tokenbox-bridge/);
  assert.equal(packageJson.scripts["stage:bridge"], "node scripts/stage-tokenbox-bridge.js");
  assert.match(read("scripts/stage-tokenbox-bridge.js"), /tokenbox-bridge\.exe/);
});
