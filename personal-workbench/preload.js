const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbench", {
  startTerminal: () => ipcRenderer.send("terminal:start"),
  sendTerminalInput: (data) => ipcRenderer.send("terminal:input", data),
  onTerminalData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  getExtensions: () => ipcRenderer.invoke("extensions:get"),
  saveExtensions: (entries) => ipcRenderer.invoke("extensions:save", entries)
});
