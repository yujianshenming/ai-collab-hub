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
  updateActiveTaskInfo: (info) => ipcRenderer.send("task:active-update", info),
  prepareTaskFolder: (task) => ipcRenderer.invoke("tasks:prepare-folder", task),
  cleanupTaskFolder: (folderPath) => ipcRenderer.invoke("tasks:cleanup-folder", folderPath),
  openTaskFolder: (folderPath) => ipcRenderer.invoke("tasks:open-folder", folderPath),
  listTaskFolder: (folderPath) => ipcRenderer.invoke("tasks:list-folder", folderPath),
  listTaskFiles: (folderPath) => ipcRenderer.invoke("tasks:list-files", folderPath),
  taskFileAction: (action, filePath) => ipcRenderer.invoke("tasks:file-action", { action, filePath }),
  onTaskFolderChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("task-folder-changed", listener);
    return () => ipcRenderer.removeListener("task-folder-changed", listener);
  },
  pickSystemFiles: () => ipcRenderer.invoke("dialog:pick-files"),
  cropImage: (filePath) => ipcRenderer.invoke("tasks:crop-image", filePath),
  getWorkbenchPrefs: () => ipcRenderer.invoke("prefs:get-workbench"),
  setWorkbenchPrefs: (prefs) => ipcRenderer.invoke("prefs:set-workbench", prefs),
  pickTodoFile: () => ipcRenderer.invoke("dialog:pick-todo-file"),
  readTodoFile: () => ipcRenderer.invoke("tasks:read-todo-file"),
  readWeeklyTasks: () => ipcRenderer.invoke("tasks:read-weekly"),
  writeWeeklyTasks: (tasks) => ipcRenderer.invoke("tasks:write-weekly", tasks),
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
  getSessionToken: () => ipcRenderer.invoke("workbench:get-session-token"),
  cleanupTabResources: (tabId) => ipcRenderer.invoke("tab:cleanup-resources", tabId)
});

