const { app, BrowserWindow, ipcMain, session, shell, Menu } = require("electron");
const pty = require("node-pty");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");

let mainWindow;
let terminalProcess;
let lastTerminalSize = { cols: 80, rows: 24 };
let activeTabInfo = { url: "", title: "" };
let extensionResults = [];
let localServer;
let activeTaskFolder = "";
const workbenchPartition = "persist:personal-workbench";
const localServerPort = 38924;
const downloadRoot = path.join(__dirname, "temp");
const weeklyTasksPath = path.join(__dirname, "..", "tasks", "weekly_tasks.json");

function workbenchSession() {
  return session.fromPartition(workbenchPartition);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#f6f8fc",
    title: "个人工作台",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  mainWindow.loadFile("index.html");
  mainWindow.setMenuBarVisibility(false);
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

function setAppMenu() {
  const template = [
    {
      label: "工作台",
      submenu: [
        {
          label: "扩展设置",
          click: () => sendToRenderer("menu:open-settings")
        },
        { type: "separator" },
        { label: "退出", role: "quit" }
      ]
    },
    {
      label: "任务",
      accelerator: "CmdOrCtrl+T",
      click: () => sendToRenderer("menu:toggle-tasks")
    },
    {
      label: "终端",
      accelerator: "CmdOrCtrl+`",
      click: () => sendToRenderer("menu:toggle-terminal")
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载", role: "reload" },
        { label: "开发者工具", role: "toggleDevTools" },
        { type: "separator" },
        { label: "实际大小", role: "resetZoom" },
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function startTerminal(size = {}) {
  if (terminalProcess) return;

  updateTerminalSize(size);
  terminalProcess = pty.spawn("cmd.exe", ["/Q", "/K", "chcp 65001>nul"], {
    cols: lastTerminalSize.cols,
    rows: lastTerminalSize.rows,
    cwd: os.homedir(),
    env: { ...process.env, TERM: "xterm-256color" }
  });

  terminalProcess.onData((data) => sendToRenderer("terminal:data", data));
  terminalProcess.onExit(({ exitCode }) => {
    terminalProcess = null;
    sendToRenderer("terminal:data", `\r\n[命令提示符已退出，代码 ${exitCode ?? "未知"}]\r\n`);
  });
}

function updateTerminalSize(size = {}) {
  const cols = Number(size.cols);
  const rows = Number(size.rows);
  if (Number.isFinite(cols)) lastTerminalSize.cols = Math.max(20, cols);
  if (Number.isFinite(rows)) lastTerminalSize.rows = Math.max(6, rows);
}

function canLoadInWebview(url) {
  return /^(https?|file|chrome-extension):\/\//i.test(url);
}

async function getWorkbenchCookies(details = {}) {
  const filter = { ...details };
  if (!filter.url && /^https?:\/\//i.test(activeTabInfo.url)) filter.url = activeTabInfo.url;
  try {
    return await workbenchSession().cookies.get(filter);
  } catch {
    return [];
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function startLocalServer() {
  if (localServer) return;

  localServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${localServerPort}`);
    if (parsedUrl.pathname === "/active-tab") {
      sendJson(res, 200, activeTabInfo);
      return;
    }

    if (parsedUrl.pathname === "/cookies") {
      const filter = {};
      const url = parsedUrl.searchParams.get("url");
      const name = parsedUrl.searchParams.get("name");
      if (url) filter.url = url;
      if (name) filter.name = name;
      sendJson(res, 200, await getWorkbenchCookies(filter));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  localServer.on("error", () => {
    localServer = null;
  });
  localServer.listen(localServerPort, "127.0.0.1");
}

function stopLocalServer() {
  if (!localServer) return;
  localServer.close();
  localServer = null;
}

function stopTerminal() {
  if (terminalProcess) {
    terminalProcess.kill();
  }
  terminalProcess = null;
}

function ensureJsonArrayFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "[]", "utf8");
  }
}

function readWeeklyTasks() {
  ensureJsonArrayFile(weeklyTasksPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(weeklyTasksPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeWeeklyTasks(tasks) {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  fs.mkdirSync(path.dirname(weeklyTasksPath), { recursive: true });
  fs.writeFileSync(weeklyTasksPath, JSON.stringify(safeTasks, null, 2), "utf8");
  return safeTasks;
}

function safeDownloadName(filename) {
  const fallback = "download.bin";
  return path.basename(filename || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || fallback;
}

function safePathPart(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60) || "untitled";
}

function classifyDownload(filename) {
  const lowerName = filename.toLowerCase();
  if (/\.(json|txt|md)$/i.test(filename) || lowerName.includes("chat") || lowerName.includes("dialog")) {
    return { type: "chat", folder: "chats" };
  }
  if (/\.(pdf|html?)$/i.test(filename) || lowerName.includes("report") || lowerName.includes("eval")) {
    return { type: "report", folder: "reports" };
  }
  return { type: "generic", folder: "downloads" };
}

function cleanupTaskFolder(folderPath) {
  const tasksRoot = path.resolve(downloadRoot, "tasks");
  const target = path.resolve(String(folderPath || ""));
  if (!target.startsWith(`${tasksRoot}${path.sep}`)) return false;
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  if (activeTaskFolder && path.resolve(activeTaskFolder) === target) activeTaskFolder = "";
  return true;
}

function installDownloadHandler() {
  workbenchSession().on("will-download", (_event, item) => {
    const filename = safeDownloadName(item.getFilename());
    const classification = classifyDownload(filename);
    const saveDir = activeTaskFolder && classification.type !== "generic"
      ? activeTaskFolder
      : path.join(downloadRoot, classification.folder);
    fs.mkdirSync(saveDir, { recursive: true });
    const extension = path.extname(filename) || ".bin";
    const archiveName = {
      chat: "dialogue.json",
      report: `eval_report${extension}`
    }[classification.type] || `${Date.now()}_${filename}`;
    const savePath = path.join(saveDir, archiveName);
    item.setSavePath(savePath);

    item.once("done", (_doneEvent, state) => {
      if (state !== "completed") return;
      sendToRenderer("download-completed", {
        type: classification.type,
        path: savePath,
        filename
      });
    });
  });
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

function readExtensionIcon(extensionPath, iconPath) {
  if (!iconPath) return "";
  const fullPath = path.resolve(extensionPath, iconPath);
  if (!fullPath.startsWith(`${path.resolve(extensionPath)}${path.sep}`) || !fs.existsSync(fullPath)) return "";
  const mimeType = {
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
  }[path.extname(fullPath).toLowerCase()];
  return mimeType ? `data:${mimeType};base64,${fs.readFileSync(fullPath).toString("base64")}` : "";
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
      const manifestPath = path.join(extensionPath, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : {};
      const action = manifest.action || manifest.browser_action || {};
      const defaultIcon = typeof action.default_icon === "string"
        ? action.default_icon
        : action.default_icon?.["16"] || action.default_icon?.["32"] || manifest.icons?.["16"] || manifest.icons?.["32"] || "";

      const extension = await workbenchSession().extensions.loadExtension(extensionPath, {
        allowFileAccess: true
      });
      results.push({
        ...entry,
        id: extension.id,
        ok: true,
        name: extension.name,
        version: extension.version,
        path: extensionPath,
        popupPage: action.default_popup || manifest.side_panel?.default_path || manifest.options_page || manifest.options_ui?.page || "",
        defaultIcon,
        iconDataUrl: readExtensionIcon(extensionPath, defaultIcon),
        message: "已成功启用"
      });
    } catch (error) {
      results.push({ ...entry, ok: false, path: extensionPath, message: error.message });
    }
  }
  return results;
}

function installEmbedHeaderFilter() {
  workbenchSession().webRequest.onHeadersReceived(
    { urls: ["http://*/*", "https://*/*"], types: ["subFrame"] },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      for (const name of Object.keys(responseHeaders)) {
        const normalized = name.toLowerCase();
        if (normalized === "x-frame-options" || normalized === "content-security-policy") {
          delete responseHeaders[name];
        }
      }
      callback({ cancel: false, responseHeaders });
    }
  );
}

function registerIpc() {
  ipcMain.on("terminal:start", (_event, size) => startTerminal(size));
  ipcMain.on("terminal:input", (_event, data) => {
    if (!terminalProcess) startTerminal();
    terminalProcess?.write(data);
  });
  ipcMain.on("terminal:resize", (_event, size) => {
    updateTerminalSize(size);
    if (!terminalProcess) return;
    terminalProcess.resize(lastTerminalSize.cols, lastTerminalSize.rows);
  });
  ipcMain.on("tab:active-update", (_event, info = {}) => {
    activeTabInfo = {
      url: String(info.url || ""),
      title: String(info.title || "")
    };
  });
  ipcMain.on("task:active-update", (_event, info = {}) => {
    activeTaskFolder = String(info.folderPath || "");
  });
  ipcMain.handle("tasks:prepare-folder", (_event, task = {}) => {
    const folderName = [
      safePathPart(task.id),
      safePathPart(task.school),
      safePathPart(task.course)
    ].join("_");
    const folderPath = path.join(downloadRoot, "tasks", folderName);
    fs.mkdirSync(folderPath, { recursive: true });
    activeTaskFolder = folderPath;
    return folderPath;
  });
  ipcMain.handle("tasks:cleanup-folder", (_event, folderPath) => cleanupTaskFolder(folderPath));
  ipcMain.handle("workbench:get-active-tab-info", () => activeTabInfo);
  ipcMain.handle("workbench:get-cookies", async (_event, details = {}) => {
    return getWorkbenchCookies(details);
  });
  ipcMain.handle("tasks:read-weekly", () => readWeeklyTasks());
  ipcMain.handle("tasks:write-weekly", (_event, tasks) => writeWeeklyTasks(tasks));

  ipcMain.handle("extensions:get", () => ({
    entries: readExtensionConfig(),
    results: extensionResults
  }));
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
    extensionResults = await loadConfiguredExtensions(safeEntries);
    return extensionResults;
  });
  ipcMain.handle("extensions:refresh", async () => {
    for (const extension of workbenchSession().extensions.getAllExtensions()) {
      try {
        await workbenchSession().extensions.removeExtension(extension.id);
      } catch {}
    }
    extensionResults = await loadConfiguredExtensions();
    return extensionResults;
  });
}

app.whenReady().then(async () => {
  setAppMenu();
  registerIpc();
  installEmbedHeaderFilter();
  installDownloadHandler();

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") {
      contents.setWindowOpenHandler(({ url }) => {
        if (canLoadInWebview(url)) {
          contents.loadURL(url).catch(() => {});
        } else {
          shell.openExternal(url).catch(() => {});
        }
        return { action: "deny" };
      });
    }
  });

  startLocalServer();
  extensionResults = await loadConfiguredExtensions();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopTerminal();
  stopLocalServer();
  if (process.platform !== "darwin") app.quit();
});
