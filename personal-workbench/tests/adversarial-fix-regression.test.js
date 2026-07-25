const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const preloadSrc = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
const rendererSrc = fs.readFileSync(path.join(ROOT, "renderer.js"), "utf8");

test("desktop launch is gated by a main-process realpath allowlist", () => {
  assert.match(mainSrc, /function canonicalDesktopAppPath\(candidate\)/);
  assert.match(mainSrc, /function isApprovedDesktopAppPath\(candidate\)/);
  assert.match(mainSrc, /const approvedExePath = isApprovedDesktopAppPath\(exePath\)/);
  assert.match(mainSrc, /spawn\(approvedExePath, \[\],/);
  assert.match(mainSrc, /approveDesktopAppPath\(result\.filePaths\[0\]\)/);
  assert.match(mainSrc, /loadDesktopAppAllowlist\(\);/);
});

test("todo file path is main-owned and validated before read/write", () => {
  assert.match(mainSrc, /delete next\.todoFilePath/);
  assert.match(mainSrc, /function resolveConfiguredTodoFilePath\(\)/);
  assert.match(mainSrc, /resolveConfiguredPathCandidate\(picked\)/);
  assert.match(mainSrc, /const resolved = resolveConfiguredTodoFilePath\(\);/);
});

test("local webviews receive scoped tokens rather than the session token", () => {
  assert.doesNotMatch(preloadSrc, /getSessionToken/);
  assert.doesNotMatch(rendererSrc, /getSessionToken/);
  assert.match(mainSrc, /const localAppAccessTokens = new Map\(\)/);
  assert.match(mainSrc, /LOCAL_APP_ALLOWED_ROUTES/);
  assert.match(mainSrc, /localAppAccessTokens\.set\(token/);
  assert.match(rendererSrc, /getLocalAppToken\(tab\.id\)/);
});

test("cookie HTTP access requires an explicit HTTP(S) URL", () => {
  assert.match(mainSrc, /Cookie URL is required and must use http or https/);
  assert.match(mainSrc, /workbenchSession\(\)\.cookies\.get\(filter\)/);
  assert.ok(mainSrc.includes('if (!/^https?:\\/\\//i.test(String(filter.url || ""))) return [];'));
});

test("upload injection validates task-folder or main-process approval", () => {
  assert.match(mainSrc, /const approvedUploadPaths = new Map\(\)/);
  assert.match(mainSrc, /function validateUploadPaths\(paths, taskFolder = ""\)/);
  assert.match(mainSrc, /const validated = validateUploadPaths\(paths, request\.taskFolder\)/);
  assert.match(mainSrc, /taskFolder: activeTaskFolder/);
  assert.match(mainSrc, /rememberApprovedUploadPaths\(result\.filePaths\)/);
});

test("completed imports receive a timestamp and purge uses completedAt only", () => {
  assert.match(rendererSrc, /completedAtRaw \|\| new Date\(\)\.toISOString\(\)/);
  assert.match(rendererSrc, /importedCompletedNeedStamp/);
  assert.match(rendererSrc, /return isoWeekKeyFromIsoTimestamp\(task\?\.completedAt\) \|\| ""/);
  assert.doesNotMatch(rendererSrc, /completedOwnershipWeek[\s\S]{0,260}task\?\.updatedAt/);
});

test("report generation filters by period while retaining source orphans", () => {
  assert.match(rendererSrc, /function taskBelongsToReportPeriod\(task, periodKey\)/);
  assert.match(rendererSrc, /weeklyTasks\.filter\(\(task\) => taskBelongsToReportPeriod\(task, report\.periodKey\)\)/);
  assert.match(rendererSrc, /const orphanSourceRows = rows\.filter/);
  assert.match(rendererSrc, /return \[\.\.\.generated, \.\.\.orphanSourceRows, \.\.\.manualRows\]/);
});

test("same-lane task drops preserve running state", () => {
  assert.match(rendererSrc, /function taskStatusForDrop\(task, lane\)/);
  assert.match(rendererSrc, /fromLane !== targetLane && pipelineState\.active/);
  assert.match(rendererSrc, /const nextStatus = taskStatusForDrop\(task, targetLane\)/);
  assert.match(rendererSrc, /const statusChanged = task\.status !== nextStatus/);
});

test("artifact rename/delete and refresh retarget stored paths", () => {
  assert.match(mainSrc, /previousPath: target/);
  assert.match(rendererSrc, /function syncTaskArtifactPathAfterFileAction\(previousPath, nextPath = ""\)/);
  assert.match(rendererSrc, /await syncTaskArtifactPathAfterFileAction\(file\.path, result\.path \|\| ""\)/);
  assert.match(rendererSrc, /await syncTaskArtifactPathAfterFileAction\(file\.path, ""\)/);
  assert.match(rendererSrc, /current\.chatLogPath && !badges\.chat\.ready/);
  assert.match(rendererSrc, /current\.reportPath && !badges\.report\.ready/);
});

test("local server startup failures are observable through IPC and UI", () => {
  assert.match(mainSrc, /updateLocalServerStatus\(\{ running: false, error:/);
  assert.match(mainSrc, /ipcMain\.handle\("local-server:status"/);
  assert.match(preloadSrc, /getLocalServerStatus/);
  assert.match(preloadSrc, /onLocalServerStatus/);
  assert.match(rendererSrc, /handleLocalServerStatus/);
});
