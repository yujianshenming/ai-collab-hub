const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { transitionTask } = require("../task-state-engine");

const root = path.resolve(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(root, "main.js"), "utf8");
const rendererSrc = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const popupSrc = fs.readFileSync(path.join(root, "preload-popup.js"), "utf8");
const styleSrc = fs.readFileSync(path.join(root, "style.css"), "utf8");

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `cannot extract ${startMarker}`);
  return source.slice(start, end).trim();
}

test("pipeline classification requires an explicit artifact name and expected step", () => {
  const functionSource = extractBetween(mainSrc, "function classifyDownload", "// 工作台偏好");
  const classifyDownload = vm.runInNewContext(`(${functionSource})`);
  assert.equal(classifyDownload("help.pdf", true, "evaluating").type, "generic");
  assert.equal(classifyDownload("notes.txt", true, "testing").type, "generic");
  assert.equal(classifyDownload("dialogue.json", true, "testing").type, "chat");
  assert.equal(classifyDownload("dialogue.json", true, "evaluating").type, "generic");
  assert.equal(classifyDownload("eval_report.pdf", true, "evaluating").type, "report");
});

test("download completion keeps captured task identity and reports terminal state", () => {
  assert.match(mainSrc, /const downloadTaskId = hasActiveTask \? activeTaskId : ""/);
  assert.match(mainSrc, /state,\s*type: classification\.type/);
  assert.match(mainSrc, /filename: path\.basename\(savePath\)/);
  assert.match(mainSrc, /taskId: downloadTaskId/);
  assert.match(mainSrc, /taskStep: downloadTaskStep/);
  assert.match(rendererSrc, /download\.taskId && !matchesActiveTask/);
  assert.match(rendererSrc, /updateTaskFields\(download\.taskId/);
  assert.match(rendererSrc, /已忽略当前步骤不再需要的对话下载/);
});

test("task persistence fails closed and reconciles orphan running states", () => {
  assert.match(mainSrc, /Weekly tasks file must contain a JSON array/);
  assert.match(mainSrc, /Refusing to overwrite an invalid weekly tasks file/);
  assert.match(mainSrc, /"backups", "weekly_tasks\.json"/);
  assert.match(mainSrc, /fs\.renameSync\(tempPath, weeklyTasksPath\)/);
  assert.match(rendererSrc, /if \(!weeklyTasksLoadedSuccessfully\)/);
  assert.match(rendererSrc, /transitionTask\(task, \{ type: "recover-startup" \}\)/);
  const recovered = transitionTask({
    quantity: 1,
    status: "running",
    subtasks: [{ index: 1, status: "running" }]
  }, { type: "recover-startup" });
  assert.equal(recovered.task.status, "paused");
  assert.equal(recovered.task.subtasks[0].status, "paused");
  assert.match(rendererSrc, /cleanupPending: Boolean\(task\.cleanupPending\)/);
  assert.match(rendererSrc, /deletePending: Boolean\(task\.deletePending\)/);
});

test("task transitions and delayed launches are cancellation-aware", () => {
  assert.match(rendererSrc, /const transitionGeneration = \+\+taskTransitionGeneration/);
  assert.match(rendererSrc, /transitionGeneration !== taskTransitionGeneration/);
  assert.match(rendererSrc, /activateTaskFolder/);
  assert.match(rendererSrc, /clearTimeout\(autoLaunchTimer\)/);
  assert.match(rendererSrc, /clearTimeout\(cliStartTimer\)/);
  assert.match(mainSrc, /runningDesktopApps\.get\(tabId\) !== appInfo/);
  assert.match(mainSrc, /tabPtyProcesses\.get\(tabId\) !== ptyProcess/);
  assert.match(mainSrc, /ipcMain\.handle\("task:active-update"/);
  assert.match(rendererSrc, /同步活动任务状态失败/);
});

test("extension and local-app privileges are origin, permission, and realpath scoped", () => {
  assert.match(popupSrc, /TRUSTED_EXTENSION_PAGE/);
  assert.doesNotMatch(popupSrc, /window\.__workbenchSessionToken/);
  assert.match(mainSrc, /requireExtensionCapability\(event, "cookies"\)/);
  assert.match(mainSrc, /extensionCanAccessUrl/);
  assert.match(mainSrc, /resolveExtensionRelativePath\(extensionPath, backgroundScript\)/);
  assert.match(mainSrc, /await unloadConfiguredExtensions\(\)/);
  assert.match(mainSrc, /resolveContainedRealPath\(resolvedBase, targetPath\)/);
  assert.match(rendererSrc, /isRegisteredLocalAppUrl\(tab, currentUrl\)/);
  assert.match(rendererSrc, /extWebview\.addEventListener\("will-navigate"/);
});

test("extension capabilities require the exact declared host", () => {
  const context = vm.createContext({
    URL,
    extensionApiBaseUrl: "https://cloudapi.polymas.com"
  });
  vm.runInContext(extractBetween(mainSrc, "function extensionCanAccessUrl", "function resolveContainedRealPath"), context);
  vm.runInContext(extractBetween(mainSrc, "function getExtensionCapabilities", "function resolveExtensionRelativePath"), context);
  const allowed = context.getExtensionCapabilities({
    permissions: ["tabs", "cookies"],
    host_permissions: ["https://*.polymas.com/*"]
  });
  const lookalike = context.getExtensionCapabilities({
    permissions: ["tabs", "cookies"],
    host_permissions: ["https://evilpolymas.com/*"]
  });
  const unprivileged = context.getExtensionCapabilities({ permissions: [] });
  assert.equal(allowed.api, true);
  assert.equal(allowed.cookies, true);
  assert.equal(lookalike.api, false);
  assert.equal(unprivileged.tabs, false);
  assert.equal(unprivileged.cookies, false);
});

test("resource polling and critical feedback remain bounded and accessible", () => {
  assert.match(mainSrc, /embeddedWindowRects\.get\(tabId\) === rectKey/);
  assert.match(mainSrc, /embeddedWindowPendingRects\.get\(tabId\) === rectKey/);
  assert.match(mainSrc, /if \(code === 0\) embeddedWindowRects\.set\(tabId, rectKey\)/);
  assert.match(mainSrc, /debuggerMessageHandlers\.get\(contents\)/);
  assert.match(mainSrc, /contents\.debugger\.removeListener\("message", messageHandler\)/);
  assert.match(rendererSrc, /prefsFeedback\.dataset\.type = type/);
  assert.match(rendererSrc, /toast\.setAttribute\("role", type === "error" \? "alert" : "status"\)/);
  assert.match(styleSrc, /\.rail-artifact:focus-within \.ra-actions/);
  assert.match(styleSrc, /--text-3: #66728a/);
  assert.match(styleSrc, /\.modal \{[^}]*overflow: hidden/);
  assert.match(styleSrc, /\.modal form \{[^}]*overflow-y: auto/);
  assert.match(rendererSrc, /window\.innerWidth <= 1050[\s\S]*right-sidebar-open[\s\S]*taskRailCollapsed = true/);
});

test("E2E runs isolate profile, task storage, and download storage", () => {
  const isolationSrc = fs.readFileSync(path.join(root, "tests", "e2e-isolation.js"), "utf8");
  assert.match(mainSrc, /PERSONAL_WORKBENCH_USER_DATA/);
  assert.match(mainSrc, /PERSONAL_WORKBENCH_DOWNLOAD_ROOT/);
  assert.match(isolationSrc, /PERSONAL_WORKBENCH_USER_DATA/);
  assert.match(isolationSrc, /PERSONAL_WORKBENCH_DOWNLOAD_ROOT/);
});
