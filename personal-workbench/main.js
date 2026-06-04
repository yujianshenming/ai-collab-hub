const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let mainWindow;
let terminalProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#f6f8fc",
    title: "个人工作台",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  mainWindow.loadFile("index.html");
  mainWindow.on("closed", () => {
    mainWindow = null;
    stopTerminal();
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startTerminal() {
  if (terminalProcess && !terminalProcess.killed) return;

  terminalProcess = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"],
    {
      cwd: os.homedir(),
      env: { ...process.env, TERM: "xterm-256color" },
      windowsHide: true
    }
  );

  terminalProcess.stdout.on("data", (data) => sendToRenderer("terminal:data", data.toString()));
  terminalProcess.stderr.on("data", (data) => sendToRenderer("terminal:data", data.toString()));
  terminalProcess.on("exit", (code) => {
    terminalProcess = null;
    sendToRenderer("terminal:data", `\r\n[PowerShell 已退出，代码 ${code ?? "未知"}]\r\n`);
  });
  terminalProcess.on("error", (error) => {
    sendToRenderer("terminal:data", `\r\n[无法启动 PowerShell: ${error.message}]\r\n`);
  });
}

function stopTerminal() {
  if (terminalProcess && !terminalProcess.killed) {
    terminalProcess.kill();
  }
  terminalProcess = null;
}

function extensionConfigPath() {
  return path.join(app.getPath("userData"), "extensions.json");
}

function readExtensionConfig() {
  const configPath = extensionConfigPath();
  if (!fs.existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveExtensionPath(entry) {
  if (entry.path) return path.resolve(entry.path);
  if (!entry.id) return null;

  const profilesRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Google",
    "Chrome",
    "User Data"
  );
  if (!fs.existsSync(profilesRoot)) return null;

  const profiles = fs
    .readdirSync(profilesRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && (item.name === "Default" || item.name.startsWith("Profile ")));

  for (const profile of profiles) {
    const root = path.join(profilesRoot, profile.name, "Extensions", entry.id);
    if (!fs.existsSync(root)) continue;
    const versions = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) return path.join(root, versions[0]);
  }
  return null;
}

async function loadConfiguredExtensions(entries = readExtensionConfig()) {
  const results = [];
  for (const entry of entries.filter((item) => item && item.enabled !== false)) {
    const extensionPath = resolveExtensionPath(entry);
    if (!extensionPath || !fs.existsSync(extensionPath)) {
      results.push({ ...entry, ok: false, message: "未找到扩展目录" });
      continue;
    }
    try {
      const extension = await session.defaultSession.loadExtension(extensionPath, {
        allowFileAccess: true
      });
      results.push({
        ...entry,
        ok: true,
        name: extension.name,
        path: extensionPath,
        message: "已加载"
      });
    } catch (error) {
      results.push({ ...entry, ok: false, path: extensionPath, message: error.message });
    }
  }
  return results;
}

function registerIpc() {
  ipcMain.on("terminal:start", startTerminal);
  ipcMain.on("terminal:input", (_event, data) => {
    if (!terminalProcess || terminalProcess.killed) startTerminal();
    terminalProcess?.stdin.write(data);
  });

  ipcMain.handle("extensions:get", () => readExtensionConfig());
  ipcMain.handle("extensions:save", async (_event, entries) => {
    const safeEntries = Array.isArray(entries)
      ? entries.map(({ id = "", path: extensionPath = "", enabled = true }) => ({
          id: String(id).trim(),
          path: String(extensionPath).trim(),
          enabled: Boolean(enabled)
        }))
      : [];
    fs.mkdirSync(path.dirname(extensionConfigPath()), { recursive: true });
    fs.writeFileSync(extensionConfigPath(), JSON.stringify(safeEntries, null, 2), "utf8");
    return loadConfiguredExtensions(safeEntries);
  });
}

app.whenReady().then(async () => {
  registerIpc();

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
      });
    }
  });

  await loadConfiguredExtensions();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopTerminal();
  if (process.platform !== "darwin") app.quit();
});
