const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const popupSrc = fs.readFileSync(path.join(ROOT, "preload-popup.js"), "utf8");
const rendererSrc = fs.readFileSync(path.join(ROOT, "renderer.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");

test("popup compat exposes runtime/storage bridge for plugin side panels", () => {
  assert.match(popupSrc, /const bridgeHandlers = \{/);
  assert.match(popupSrc, /GET_CURRENT_TAB_URL:/);
  assert.match(popupSrc, /GET_CURRENT_TAB_INFO:/);
  assert.match(popupSrc, /GET_AUTH:/);
  assert.match(popupSrc, /EXTRACT_TRAIN_TASK_ID:/);
  assert.match(popupSrc, /EXTRACT_PAGE_IDS:/);
  assert.match(popupSrc, /GET_PLATFORM_CONFIG:/);
  assert.match(popupSrc, /API_REQUEST:/);

  assert.match(popupSrc, /chromeApi\.storage = chromeApi\.storage \|\| \{\}/);
  assert.match(popupSrc, /chromeApi\.storage\.local = createStorageLocal/);
  assert.match(popupSrc, /const onChanged = originalStorageLocal\?\.onChanged \|\| \{/);
  assert.match(popupSrc, /return \{ get, set, onChanged \}/);
  assert.match(popupSrc, /sendMessage: \(\.\.\.args\) =>/);
  assert.match(popupSrc, /const extensionOrigin = window\.location\.protocol === "chrome-extension:"/);
  assert.match(popupSrc, /\? window\.location\.hostname/);
  assert.match(popupSrc, /id: originalRuntime\.id \|\| fallbackRuntimeId/);
  assert.match(popupSrc, /getURL: originalRuntime\.getURL/);
  assert.match(popupSrc, /const baseUrl = extensionOrigin \|\| `chrome-extension:\/\/\$\{runtime\.id\}`/);
});

test("popup preload cannot be aborted by optional main-world bridge setup", () => {
  assert.match(popupSrc, /const \{ contextBridge, ipcRenderer \} = require\("electron"\)/);
  assert.match(popupSrc, /debugLog\("preload:init", \{/);
  assert.match(popupSrc, /contextIsolated: Boolean\(process\.contextIsolated\)/);
  assert.match(popupSrc, /if \(process\.contextIsolated && TRUSTED_EXTENSION_PAGE\) \{/);
  assert.match(popupSrc, /contextBridge\.executeInMainWorld\(\{ func: mainWorldBridgeBootstrap \}\)/);
  assert.doesNotMatch(popupSrc, /appendChild\(script\)/);
  assert.match(popupSrc, /installMainWorldBridge\(\);/);
  assert.match(popupSrc, /debugLog\("main-world:bridge-error", \{/);
  assert.match(popupSrc, /if \(TRUSTED_EXTENSION_PAGE && window\.chrome\) \{/);
  assert.match(popupSrc, /patchChromeApis\(window\.chrome\);/);
  assert.doesNotMatch(popupSrc, /window\.__workbenchSessionToken/);
});

test("popup compat forwards tab url change messages to runtime listeners", () => {
  assert.match(popupSrc, /const runtimeMessageListeners = new Set\(\)/);
  assert.match(popupSrc, /emitRuntimeMessage\(\{ type: "TAB_URL_CHANGED"/);
  assert.match(popupSrc, /chromeApi\.runtime = runtime/);
  assert.match(popupSrc, /onMessage: \{/);
  assert.match(popupSrc, /addListener\(listener\)/);
  assert.match(popupSrc, /removeListener\(listener\)/);
});

test("popup compat prioritizes bridge handlers only for popup context messages", () => {
  assert.match(popupSrc, /debugLog\("bridge:get-current-tab-url", \{ url \}\)/);
  assert.match(popupSrc, /query: mockTabs\.query/);
  assert.match(popupSrc, /getSelected: mockTabs\.getSelected/);
  assert.match(popupSrc, /get: mockTabs\.get/);
  assert.match(popupSrc, /getAll: mockCookies\.getAll/);
  assert.match(popupSrc, /get: mockCookies\.get/);
  assert.match(popupSrc, /const BRIDGE_FIRST_MESSAGE_TYPES = new Set\(/);
  assert.match(popupSrc, /"GET_CURRENT_TAB_URL"/);
  assert.match(popupSrc, /"GET_CURRENT_TAB_INFO"/);
  assert.match(popupSrc, /"GET_AUTH"/);
  assert.match(popupSrc, /"EXTRACT_TRAIN_TASK_ID"/);
  assert.match(popupSrc, /"EXTRACT_PAGE_IDS"/);
  assert.match(popupSrc, /"GET_PLATFORM_CONFIG"/);
  assert.match(popupSrc, /"API_REQUEST"/);
  assert.match(popupSrc, /const messageType = String\(message\?\.type \|\| ""\)/);
  assert.match(popupSrc, /if \(handler && BRIDGE_FIRST_MESSAGE_TYPES\.has\(messageType\)\) \{/);
  assert.match(popupSrc, /if \(originalSendMessage\) \{/);
  assert.match(popupSrc, /if \(handler\) \{/);
});

test("popup compat proxies platform API requests through main process", () => {
  assert.match(popupSrc, /ipcRenderer\.invoke\("workbench:extension-api-request", payload\)/);
  assert.doesNotMatch(popupSrc, /const response = await fetch\(url/);
  assert.match(popupSrc, /function extractStepBoundary\(payload\)/);
  assert.match(popupSrc, /endpoint: "\/teacher-course\/abilityTrain\/queryScriptStepList"/);
  assert.match(mainSrc, /ipcMain\.handle\("workbench:extension-api-request"/);
  assert.match(mainSrc, /const extensionApiBaseUrl = "https:\/\/cloudapi\.polymas\.com"/);
  assert.match(mainSrc, /resolved\.origin !== extensionApiBaseUrl/);
  assert.match(mainSrc, /headers\.Authorization = authorization/);
  assert.match(mainSrc, /headers\.Cookie = cookieHeader/);
});

test("main process loads Electron-compatible extension copies with Chrome API polyfills", () => {
  assert.match(mainSrc, /function prepareExtensionForElectron\(extensionPath, manifest = \{\}, token, capabilities\)/);
  assert.match(mainSrc, /workbench-electron-storage-polyfill/);
  assert.match(mainSrc, /const asChromeAsync = \(executor\) => \(\.\.\.args\) => \{/);
  assert.match(mainSrc, /const callback = typeof args\[args\.length - 1\] === "function"/);
  assert.match(mainSrc, /chromeApi\.storage\.local = chromeApi\.storage\.local \|\| createArea\("local"\)/);
  assert.match(mainSrc, /chromeApi\.storage\.sync = chromeApi\.storage\.sync \|\| createArea\("sync"\)/);
  assert.match(mainSrc, /chromeApi\.storage\.session = chromeApi\.storage\.session \|\| createArea\("session"\)/);
  assert.match(mainSrc, /chromeApi\.tabs\.query = asChromeAsync\(async \(\) => \{/);
  assert.match(mainSrc, /workbenchFetchJson\("\/active-tab"\)/);
  assert.match(mainSrc, /chromeApi\.cookies\.getAll = asChromeAsync\(async \(details = \{\}\) => \{/);
  assert.ok(mainSrc.includes("const cookies = await workbenchFetchJson(\\`/cookies?\\${params.toString()}\\`);"));
  assert.match(mainSrc, /background-polyfill:tabs-query/);
  assert.match(mainSrc, /background-polyfill:cookies-get-all/);
  assert.match(mainSrc, /fs\.cpSync\(extensionPath, targetRoot, \{ recursive: true \}\)/);
  assert.match(mainSrc, /fs\.writeFileSync\(\s*targetBackgroundPath/);
  assert.match(mainSrc, /const loadPath = prepareExtensionForElectron\(extensionPath, manifest, accessToken, capabilities\)/);
  assert.match(mainSrc, /extensions\.loadExtension\(loadPath/);
  assert.match(mainSrc, /function getExtensionCapabilities\(manifest = \{\}\)/);
  assert.match(mainSrc, /resolveExtensionRelativePath\(extensionPath, backgroundScript\)/);
});

test("renderer extension panel logs popup load and runtime errors", () => {
  assert.match(rendererSrc, /allowedExtensionPrefix/);
  assert.match(rendererSrc, /extWebview\.addEventListener\("will-navigate"/);
  assert.match(rendererSrc, /extWebview\.addEventListener\("dom-ready"/);
  assert.match(rendererSrc, /extWebview\.addEventListener\("console-message"/);
  assert.match(rendererSrc, /extWebview\.addEventListener\("did-fail-load"/);
  assert.match(rendererSrc, /showToast\(`扩展面板加载失败：\$\{name\}`/);
});
