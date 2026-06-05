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
  getExtensions: () => ipcRenderer.invoke("extensions:get"),
  saveExtensions: (entries) => ipcRenderer.invoke("extensions:save", entries),
  refreshExtensions: () => ipcRenderer.invoke("extensions:refresh")
});
