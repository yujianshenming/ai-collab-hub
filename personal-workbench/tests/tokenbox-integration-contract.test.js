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
  assert.match(main, /ipcMain\.handle\("tokenbox:evidence"/);
  assert.match(main, /ipcMain\.handle\("tokenbox:rebuild"/);
  assert.doesNotMatch(main, /ipcMain\.handle\("tokenbox:relay-import"/);
  assert.doesNotMatch(main, /ipcMain\.handle\("tokenbox:reconciliation"/);
  assert.doesNotMatch(main, /ipcMain\.handle\("tokenbox:export-reconciliation"/);
  assert.match(main, /TOKENBOX_BRIDGE_REQUEST_TIMEOUT_MS = 120000/);
  assert.match(main, /TOKENBOX_BRIDGE_MAX_LINE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(main, /path\.extname\(candidate\)\.toLowerCase\(\) === "\.exe"/);
  assert.doesNotMatch(main, /ipcMain\.handle\("tokenbox:[^"]+",[^\n]*method/);

  assert.match(preload, /getTokenboxStatus: \(\) => ipcRenderer\.invoke\("tokenbox:status"\)/);
  assert.match(preload, /refreshTokenbox: \(filter\) => ipcRenderer\.invoke\("tokenbox:refresh", \{ filter \}\)/);
  assert.match(preload, /getTokenboxEvidence: \(payload\) => ipcRenderer\.invoke\("tokenbox:evidence", payload\)/);
  assert.match(preload, /rebuildTokenboxLedger: \(provider\) => ipcRenderer\.invoke\("tokenbox:rebuild", \{ provider \}\)/);
  assert.doesNotMatch(preload, /importTokenboxRelay/);
  assert.doesNotMatch(preload, /getTokenboxReconciliation/);
  assert.doesNotMatch(preload, /exportTokenboxReconciliation/);
  assert.match(renderer, /const TOKENBOX_ID = "__tokenbox__"/);
  assert.match(renderer, /window\.workbench\.refreshTokenbox\(tokenboxFilter\(\)\)/);
  assert.match(renderer, /window\.workbench\.getTokenboxEvidence/);
  assert.match(renderer, /window\.workbench\.getTokenboxAudit/);
  assert.doesNotMatch(renderer, /importTokenboxRelay|refreshTokenboxReconciliation|exportTokenboxReconciliation/);
  assert.match(html, /id="tokenbox-view"/);
  assert.match(html, /id="tokenbox-trend-chart"/);
  assert.match(html, /id="tokenbox-model-chart"/);
  assert.match(html, /id="tokenbox-model-legend"/);
  assert.match(html, /id="tokenbox-models-body"/);
  assert.match(html, /id="tokenbox-daily-body"/);
  assert.match(html, /id="tokenbox-evidence-body"/);
  assert.match(html, /id="tokenbox-rebuild"/);
  assert.doesNotMatch(html, /tokenbox-relay|tokenbox-reconciliation|tokenbox-actual-cost|RELAY LEDGER|中转站/);

  assert.equal(packageJson.build.extraResources[0].from, "sidecars");
  assert.deepEqual(packageJson.build.extraResources[0].filter, ["tokenbox-bridge.exe"]);
});

test("TokenBox build scripts stage the exact bridge binary", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["build:bridge"], /build-tokenbox-bridge\.js --bin tokenbox-bridge/);
  assert.match(read("scripts/build-tokenbox-bridge.js"), /x86_64-pc-windows-gnu/);
  assert.match(read("scripts/build-tokenbox-bridge.js"), /TOKENBOX_MINGW_BIN/);
  assert.equal(packageJson.scripts["stage:bridge"], "node scripts/stage-tokenbox-bridge.js");
  assert.match(read("scripts/stage-tokenbox-bridge.js"), /tokenbox-bridge\.exe/);
});
