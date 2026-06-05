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
  refreshExtensions: () => ipcRenderer.invoke("extensions:refresh")
});
