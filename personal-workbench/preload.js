const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbench", {
  startTerminal: (size) => ipcRenderer.send("terminal:start", size),
  sendTerminalInput: (data) => ipcRenderer.send("terminal:input", data),
  resizeTerminal: (size) => ipcRenderer.send("terminal:resize", size),
  onTerminalData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  updateActiveTabInfo: (info) => ipcRenderer.send("tab:active-update", info),
  updateActiveTaskInfo: (info) => ipcRenderer.invoke("task:active-update", info),
  prepareTaskFolder: (task) => ipcRenderer.invoke("tasks:prepare-folder", task),
  activateTaskFolder: (task) => ipcRenderer.invoke("tasks:activate-folder", task),
  cleanupTaskFolder: (folderPath) => ipcRenderer.invoke("tasks:cleanup-folder", folderPath),
  openTaskFolder: (folderPath) => ipcRenderer.invoke("tasks:open-folder", folderPath),
  listTaskFolder: (folderPath) => ipcRenderer.invoke("tasks:list-folder", folderPath),
  listTaskFiles: (folderPath) => ipcRenderer.invoke("tasks:list-files", folderPath),
  taskFileAction: (action, filePath, extra = {}) =>
    ipcRenderer.invoke("tasks:file-action", { action, filePath, ...(extra && typeof extra === "object" ? extra : {}) }),
  readTaskTextFile: (filePath) => ipcRenderer.invoke("tasks:read-text-file", filePath),
  testInjectField: (webContentsId, selector, value) =>
    ipcRenderer.invoke("platform:test-inject", { webContentsId, selector, value }),
  onTaskFolderChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("task-folder-changed", listener);
    return () => ipcRenderer.removeListener("task-folder-changed", listener);
  },
  pickSystemFiles: () => ipcRenderer.invoke("dialog:pick-files"),
  onUploadChooseFiles: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("upload:choose-files", listener);
    return () => ipcRenderer.removeListener("upload:choose-files", listener);
  },
  resolveUploadFiles: (requestId, paths) => ipcRenderer.invoke("upload:resolve-files", requestId, paths),
  cropImage: (filePath) => ipcRenderer.invoke("tasks:crop-image", filePath),
  getWorkbenchPrefs: () => ipcRenderer.invoke("prefs:get-workbench"),
  setWorkbenchPrefs: (prefs) => ipcRenderer.invoke("prefs:set-workbench", prefs),
  // 公司模型网关（M2）：key 只进不出，renderer 仅能拿到 configured 布尔与注册表快照
  aiGetConfig: () => ipcRenderer.invoke("ai:get-config"),
  aiSetSecret: (key) => ipcRenderer.invoke("ai:set-secret", key),
  aiClearSecret: () => ipcRenderer.invoke("ai:clear-secret"),
  aiSetDefaultModel: (modelId) => ipcRenderer.invoke("ai:set-default-model", modelId),
  aiListModels: () => ipcRenderer.invoke("ai:list-models"),
  aiTestModel: (modelId) => ipcRenderer.invoke("ai:test-model", modelId),
  aiParseTodoLines: (payload) => ipcRenderer.invoke("ai:parse-todo-lines", payload),
  // 问题 #4：明确的取消入口，按 requestId 中止主进程里进行中的 AI 解析请求
  aiCancelParse: (requestId) => ipcRenderer.invoke("ai:cancel-parse", requestId),
  pickTodoFile: () => ipcRenderer.invoke("dialog:pick-todo-file"),
  readTodoFile: () => ipcRenderer.invoke("tasks:read-todo-file"),
  writeTodoFile: (text) => ipcRenderer.invoke("tasks:write-todo-file", text),
  readWeeklyTasks: () => ipcRenderer.invoke("tasks:read-weekly"),
  writeWeeklyTasks: (tasks) => ipcRenderer.invoke("tasks:write-weekly", tasks),
  readWeeklyReports: () => ipcRenderer.invoke("reports:read-weekly"),
  writeWeeklyReports: (reports) => ipcRenderer.invoke("reports:write-weekly", reports),
  copyWeeklyReport: (payload) => ipcRenderer.invoke("reports:copy-weekly", payload),
  exportWeeklyReport: (payload) => ipcRenderer.invoke("reports:export-weekly", payload),
  getTokenboxStatus: () => ipcRenderer.invoke("tokenbox:status"),
  backupTokenboxDatabase: () => ipcRenderer.invoke("tokenbox:backup"),
  rebuildTokenboxLedger: (provider) => ipcRenderer.invoke("tokenbox:rebuild", { provider }),
  refreshTokenbox: (filter) => ipcRenderer.invoke("tokenbox:refresh", { filter }),
  getTokenboxEvidence: (payload) => ipcRenderer.invoke("tokenbox:evidence", payload),
  exportTokenboxDashboard: (payload) => ipcRenderer.invoke("tokenbox:export-dashboard", payload),
  getTokenboxAudit: (filter) => ipcRenderer.invoke("tokenbox:audit", { filter }),
  exportTokenboxAudit: (payload) => ipcRenderer.invoke("tokenbox:export-audit", payload),
  importTokenboxRelay: (payload) => ipcRenderer.invoke("tokenbox:relay-import", payload),
  getTokenboxReconciliation: (filter) => ipcRenderer.invoke("tokenbox:reconciliation", { filter }),
  exportTokenboxReconciliation: (payload) => ipcRenderer.invoke("tokenbox:export-reconciliation", payload),
  getHomeworkVarianceStatus: () => ipcRenderer.invoke("homework-variance:status"),
  startHomeworkVariance: () => ipcRenderer.invoke("homework-variance:start"),
  stopHomeworkVariance: () => ipcRenderer.invoke("homework-variance:stop"),
  onDownloadCompleted: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("download-completed", listener);
    return () => ipcRenderer.removeListener("download-completed", listener);
  },
  onMenuToggleTasks: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("menu:toggle-tasks", listener);
    return () => ipcRenderer.removeListener("menu:toggle-tasks", listener);
  },
  onMenuToggleTerminal: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("menu:toggle-terminal", listener);
    return () => ipcRenderer.removeListener("menu:toggle-terminal", listener);
  },
  onMenuOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("menu:open-settings", listener);
    return () => ipcRenderer.removeListener("menu:open-settings", listener);
  },
  getExtensions: () => ipcRenderer.invoke("extensions:get"),
  saveExtensions: (entries) => ipcRenderer.invoke("extensions:save", entries),
  refreshExtensions: () => ipcRenderer.invoke("extensions:refresh"),
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  selectFile: () => ipcRenderer.invoke("dialog:select-file"),
  registerLocalApp: (tabId, baseDir) => ipcRenderer.invoke("local-apps:register", tabId, baseDir),
  getLocalAppToken: (tabId) => ipcRenderer.invoke("local-apps:get-token", tabId),
  getLocalServerStatus: () => ipcRenderer.invoke("local-server:status"),
  onLocalServerStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("local-server:status", listener);
    return () => ipcRenderer.removeListener("local-server:status", listener);
  },
  launchDesktopApp: (tabId, exePath, cwd, embedMode, rect) => ipcRenderer.invoke("desktop-app:launch", tabId, exePath, cwd, embedMode, rect),
  getDesktopAppStatus: (tabId) => ipcRenderer.invoke("desktop-app:status", tabId),
  killDesktopApp: (tabId) => ipcRenderer.invoke("desktop-app:kill", tabId),
  resizeEmbeddedWindow: (tabId, rect) => ipcRenderer.invoke("desktop-app:resize-window", tabId, rect),
  toggleEmbeddedWindowVisibility: (tabId, visible) => ipcRenderer.invoke("desktop-app:toggle-visibility", tabId, visible),
  onDesktopAppEmbeddedBound: (tabId, callback) => {
    const channel = `desktop-app:embedded-bound:${tabId}`;
    const listener = (_event, res) => callback(res);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onDragAddTab: (callback) => {
    const listener = (_event, path) => callback(path);
    ipcRenderer.on("tab:add-dropped-item", listener);
    return () => ipcRenderer.removeListener("tab:add-dropped-item", listener);
  },
  onDesktopAppStatusChange: (tabId, callback) => {
    const channel = `desktop-app:status-change:${tabId}`;
    const listener = (_event, status) => callback(status);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  startCliTerminal: (tabId, command, cwd, size) => ipcRenderer.send("cli-terminal:start", tabId, command, cwd, size),
  sendCliTerminalInput: (tabId, data) => ipcRenderer.send("cli-terminal:input", tabId, data),
  resizeCliTerminal: (tabId, size) => ipcRenderer.send("cli-terminal:resize", tabId, size),
  onCliTerminalData: (tabId, callback) => {
    const channel = `cli-terminal:data:${tabId}`;
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  updateTabsList: (tabs) => ipcRenderer.send("tabs:list-update", tabs),
  cleanupTabResources: (tabId) => ipcRenderer.invoke("tab:cleanup-resources", tabId)
});
