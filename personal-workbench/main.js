const { app, BrowserWindow, ipcMain, session, shell, Menu, dialog } = require("electron");
const pty = require("node-pty");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, exec } = require("node:child_process");

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow;
let terminalProcess;
let lastTerminalSize = { cols: 80, rows: 24 };
let activeTabInfo = { url: "", title: "" };
let extensionResults = [];
let localServer;
let activeTaskFolder = "";
const localAppsMap = new Map();
const runningDesktopApps = new Map();
const tabPtyProcesses = new Map();
const embeddedWindows = new Map();

// SSE & state sharing structures
const sessionToken = crypto.randomBytes(16).toString("hex");
let allTabs = [];
const sseClients = [];
const sharedStateMap = new Map();
let heartbeatInterval = null;


let resolvedScriptPath = "";

function getScriptPath() {
  if (resolvedScriptPath) return resolvedScriptPath;

  const sourcePath = path.join(__dirname, "window-binder.ps1");
  if (app.isPackaged || __dirname.includes("app.asar")) {
    const targetPath = path.join(app.getPath("userData"), "window-binder.ps1");
    try {
      const content = fs.readFileSync(sourcePath);
      fs.writeFileSync(targetPath, content);
      resolvedScriptPath = targetPath;
      return targetPath;
    } catch (err) {
      console.warn("Failed to write window-binder.ps1 to userData, trying temp folder:", err);
      try {
        const tempPath = path.join(app.getPath("temp"), `personal-workbench-window-binder-${Date.now()}.ps1`);
        const content = fs.readFileSync(sourcePath);
        fs.writeFileSync(tempPath, content);
        resolvedScriptPath = tempPath;
        return tempPath;
      } catch (tempErr) {
        console.error("Critical: Failed to extract window-binder.ps1 to temp folder too:", tempErr);
        return sourcePath;
      }
    }
  } else {
    resolvedScriptPath = sourcePath;
    return sourcePath;
  }
}

function runWindowBinder(argsArray) {
  const scriptPath = getScriptPath();
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    ...argsArray
  ];
  spawn("powershell.exe", args);
}

function bindWindow(tabId, pid, exePath, parentHwnd, rect) {
  const scriptPath = getScriptPath();
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Action", "bind",
    "-AppPid", String(pid),
    "-ExePath", exePath,
    "-ParentHWnd", String(parentHwnd),
    "-X", String(Math.round(rect.x)),
    "-Y", String(Math.round(rect.y)),
    "-Width", String(Math.round(rect.width)),
    "-Height", String(Math.round(rect.height))
  ];
  
  const child = spawn("powershell.exe", args);
  
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    errorOutput += data.toString();
  });
  
  child.on("close", (code) => {
    const hwndMatch = output.match(/BoundHWnd:(\d+)/);
    const pidMatch = output.match(/BoundPid:(\d+)/);
    
    if (hwndMatch && hwndMatch[1]) {
      const hwnd = hwndMatch[1];
      embeddedWindows.set(tabId, hwnd);
      
      if (pidMatch && pidMatch[1]) {
        const actualPid = parseInt(pidMatch[1], 10);
        const appInfo = runningDesktopApps.get(tabId);
        if (appInfo) {
          appInfo.pid = actualPid;
        }
      }
      
      sendToRenderer(`desktop-app:embedded-bound:${tabId}`, { success: true });
    } else {
      const errMsg = errorOutput.trim() || "绑定窗口超时或未找到有效窗口句柄";
      sendToRenderer(`desktop-app:embedded-bound:${tabId}`, { success: false, error: errMsg });
    }
  });
}

function handleCommandLineArgs(args) {
  const appPath = app.getAppPath();
  const candidates = args.slice(1).filter(arg => {
    if (arg.startsWith("-")) return false;
    if (arg === "." || arg === "index.html" || arg === "main.js") return false;
    try {
      if (path.resolve(arg) === path.resolve(appPath)) return false;
    } catch {}
    return /^(https?:\/\/)/i.test(arg) || fs.existsSync(arg);
  });

  if (candidates.length > 0) {
    let targetPath = candidates[0];
    let fileContent = "";
    let isDirectory = false;

    // 1. 解析 Windows 快捷方式 (.lnk) 到其真实目标
    if (targetPath.toLowerCase().endsWith(".lnk")) {
      try {
        const details = shell.readShortcutLink(targetPath);
        if (details.target && fs.existsSync(details.target)) {
          targetPath = details.target;
        }
      } catch (err) {
        console.error("解析快捷方式 .lnk 失败:", err);
      }
    }

    // 2. 解析 Internet 快捷方式 (.url) 到其真实网页 URL
    if (targetPath.toLowerCase().endsWith(".url")) {
      try {
        const content = fs.readFileSync(targetPath, "utf8");
        const match = content.match(/URL=(.+)/i);
        if (match && match[1]) {
          targetPath = match[1].trim();
        }
      } catch (err) {
        console.error("解析网页快捷方式 .url 失败:", err);
      }
    }

    // 3. 判断是否为目录以及读取常用文本文件内容
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      isDirectory = stat.isDirectory();
      if (stat.isFile()) {
        const lowerPath = targetPath.toLowerCase();
        if (lowerPath.endsWith(".md") || lowerPath.endsWith(".txt") || lowerPath.endsWith(".json")) {
          try {
            fileContent = fs.readFileSync(targetPath, "utf8");
          } catch (err) {
            console.error("读取文本文件内容失败:", err);
          }
        }
      }
    }

    // 4. 将富载荷传给渲染层
    sendToRenderer("tab:add-dropped-item", {
      path: targetPath,
      content: fileContent,
      isDirectory: isDirectory
    });
  }
}
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

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".wasm": "application/wasm"
  };
  return map[ext] || "application/octet-stream";
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
      return;
    }
    const mime = getMimeType(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

function broadcastToSse(eventName, payload) {
  const dataStr = JSON.stringify({ event: eventName, payload });
  sseClients.forEach((res) => {
    try {
      res.write(`event: message\ndata: ${dataStr}\n\n`);
    } catch (error) {
      console.warn("发送 SSE 消息失败:", error);
    }
  });
}

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) { // 1MB payload limit
        req.destroy();
        reject(new Error("Request payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
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
    const token = parsedUrl.searchParams.get("token") || req.headers["authorization"]?.split(" ")[1];

    const secureRoutes = ["/cookies", "/events", "/broadcast", "/state", "/tabs", "/active-tab", "/active-task"];
    if (secureRoutes.includes(parsedUrl.pathname)) {
      if (token !== sessionToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (parsedUrl.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      res.write(": ok\n\n");
      sseClients.push(res);

      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) {
          sseClients.splice(idx, 1);
        }
      });
      return;
    }

    if (parsedUrl.pathname === "/tabs") {
      sendJson(res, 200, allTabs);
      return;
    }

    if (parsedUrl.pathname === "/active-task") {
      sendJson(res, 200, { folderPath: activeTaskFolder });
      return;
    }

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

    if (parsedUrl.pathname === "/broadcast" && req.method === "POST") {
      try {
        const body = await getRequestBody(req);
        broadcastToSse("broadcast", body);
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (parsedUrl.pathname === "/state") {
      if (req.method === "GET") {
        const key = parsedUrl.searchParams.get("key");
        const value = key ? sharedStateMap.get(key) : undefined;
        sendJson(res, 200, { key, value });
      } else if (req.method === "POST") {
        try {
          const body = await getRequestBody(req);
          if (body && body.key !== undefined) {
            sharedStateMap.set(body.key, body.value);
            broadcastToSse("state-changed", { key: body.key, value: body.value });
            sendJson(res, 200, { success: true });
          } else {
            sendJson(res, 400, { error: "Missing key in state body" });
          }
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
      }
      return;
    }

    const localAppMatch = parsedUrl.pathname.match(/^\/local-apps\/([^/]+)\/(.*)$/);
    if (localAppMatch) {
      const tabId = localAppMatch[1];
      let relPath = decodeURIComponent(localAppMatch[2] || "");
      if (!relPath || relPath.endsWith("/")) {
        relPath += "index.html";
      }
      const baseDir = localAppsMap.get(tabId);
      if (!baseDir) {
        sendJson(res, 404, { error: "Local app directory not registered" });
        return;
      }
      
      const targetPath = path.resolve(baseDir, relPath);
      if (!targetPath.startsWith(path.resolve(baseDir))) {
        sendJson(res, 403, { error: "Access denied" });
        return;
      }

      if (!fs.existsSync(targetPath)) {
        sendJson(res, 404, { error: "File not found" });
        return;
      }

      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        const indexPath = path.join(targetPath, "index.html");
        if (fs.existsSync(indexPath)) {
          serveFile(res, indexPath);
        } else {
          sendJson(res, 404, { error: "Index file not found in directory" });
        }
        return;
      }

      serveFile(res, targetPath);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  localServer.on("error", () => {
    localServer = null;
  });
  localServer.listen(localServerPort, "127.0.0.1");

  heartbeatInterval = setInterval(() => {
    sseClients.forEach((res) => {
      try {
        res.write(": keepalive\n\n");
      } catch (e) {
        const idx = sseClients.indexOf(res);
        if (idx >= 0) sseClients.splice(idx, 1);
      }
    });
  }, 15000);
}

function stopLocalServer() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  sseClients.forEach((res) => {
    try {
      res.write("event: close\ndata: {}\n\n");
      res.end();
    } catch (e) {}
  });
  sseClients.length = 0;
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
    broadcastToSse("active-tab-changed", activeTabInfo);
  });
  ipcMain.on("task:active-update", (_event, info = {}) => {
    activeTaskFolder = String(info.folderPath || "");
    broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
  });
  ipcMain.on("tabs:list-update", (_event, list = []) => {
    allTabs = list;
    broadcastToSse("tab-list-changed", allTabs);
  });
  ipcMain.handle("workbench:get-session-token", () => sessionToken);
  ipcMain.handle("tab:cleanup-resources", (_event, tabId) => {
    const appInfo = runningDesktopApps.get(tabId);
    if (appInfo) {
      try {
        process.kill(appInfo.pid, 9);
      } catch (err) {
        if (appInfo.child) {
          try { appInfo.child.kill(); } catch (e) {}
        }
      }
      embeddedWindows.delete(tabId);
      runningDesktopApps.delete(tabId);
    }
    const ptyProcess = tabPtyProcesses.get(tabId);
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (e) {}
      tabPtyProcesses.delete(tabId);
    }
    return { success: true };
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
    broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
    return folderPath;
  });
  ipcMain.handle("tasks:cleanup-folder", (_event, folderPath) => {
    const res = cleanupTaskFolder(folderPath);
    broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
    return res;
  });
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

  ipcMain.handle("dialog:select-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"]
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("dialog:select-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"]
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("local-apps:register", (_event, tabId, baseDir) => {
    if (tabId && baseDir) {
      localAppsMap.set(String(tabId), String(baseDir));
    }
    return true;
  });

  ipcMain.handle("desktop-app:launch", async (_event, tabId, exePath, cwd, embedMode, rect) => {
    const existing = runningDesktopApps.get(tabId);
    if (existing) {
      try {
        process.kill(existing.pid, 0);
        
        // 如果程序已启动但未成功绑定窗口，重新尝试绑定
        if (embedMode && rect && !embeddedWindows.has(tabId)) {
          const buffer = mainWindow.getNativeWindowHandle();
          const parentHwnd = buffer.length === 8 
            ? buffer.readBigInt64LE(0).toString() 
            : buffer.readInt32LE(0).toString();
          bindWindow(tabId, existing.pid, exePath, parentHwnd, rect);
        }
        
        return { success: true, pid: existing.pid };
      } catch (e) {
        embeddedWindows.delete(tabId);
        runningDesktopApps.delete(tabId);
      }
    }

    try {
      const options = {};
      if (cwd && fs.existsSync(cwd)) {
        options.cwd = cwd;
      } else {
        try {
          options.cwd = path.dirname(exePath);
        } catch {}
      }

      const child = spawn(exePath, [], {
        ...options,
        detached: false,
        stdio: "ignore"
      });

      const appInfo = {
        pid: child.pid,
        child: child
      };
      runningDesktopApps.set(tabId, appInfo);

      child.on("exit", () => {
        // 如果窗口已成功绑定，则包装/启动器进程的退出属于正常现象，不清理状态
        if (embeddedWindows.has(tabId)) {
          return;
        }
        embeddedWindows.delete(tabId);
        runningDesktopApps.delete(tabId);
        sendToRenderer(`desktop-app:status-change:${tabId}`, { running: false, pid: null });
      });

      child.on("error", (err) => {
        if (embeddedWindows.has(tabId)) {
          return;
        }
        embeddedWindows.delete(tabId);
        runningDesktopApps.delete(tabId);
        sendToRenderer(`desktop-app:status-change:${tabId}`, { running: false, pid: null, error: err.message });
      });

      if (embedMode && rect) {
        const buffer = mainWindow.getNativeWindowHandle();
        const parentHwnd = buffer.length === 8 
          ? buffer.readBigInt64LE(0).toString() 
          : buffer.readInt32LE(0).toString();
        bindWindow(tabId, child.pid, exePath, parentHwnd, rect);
      }

      return { success: true, pid: child.pid };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("desktop-app:status", (_event, tabId) => {
    const appInfo = runningDesktopApps.get(tabId);
    if (!appInfo) return { running: false, pid: null };
    try {
      process.kill(appInfo.pid, 0);
      return { running: true, pid: appInfo.pid };
    } catch {
      embeddedWindows.delete(tabId);
      runningDesktopApps.delete(tabId);
      return { running: false, pid: null };
    }
  });

  ipcMain.handle("desktop-app:kill", (_event, tabId) => {
    const appInfo = runningDesktopApps.get(tabId);
    if (!appInfo) return { success: false, error: "Not running" };
    try {
      process.kill(appInfo.pid, 9);
    } catch (err) {
      if (appInfo.child) {
        try {
          appInfo.child.kill();
        } catch (e) {}
      }
    }
    embeddedWindows.delete(tabId);
    runningDesktopApps.delete(tabId);
    return { success: true };
  });

  ipcMain.handle("desktop-app:resize-window", (_event, tabId, rect) => {
    const childHwnd = embeddedWindows.get(tabId);
    if (childHwnd && rect) {
      runWindowBinder([
        "-Action", "resize",
        "-ChildHWnd", childHwnd,
        "-X", String(Math.round(rect.x)),
        "-Y", String(Math.round(rect.y)),
        "-Width", String(Math.round(rect.width)),
        "-Height", String(Math.round(rect.height))
      ]);
    }
    return true;
  });

  ipcMain.handle("desktop-app:toggle-visibility", (_event, tabId, visible) => {
    const childHwnd = embeddedWindows.get(tabId);
    if (childHwnd) {
      runWindowBinder([
        "-Action", visible ? "show" : "hide",
        "-ChildHWnd", childHwnd
      ]);
    }
    return true;
  });

  ipcMain.on("cli-terminal:start", (event, tabId, command, cwd, size = {}) => {
    if (tabPtyProcesses.has(tabId)) {
      return;
    }

    const cols = Number(size.cols) || 80;
    const rows = Number(size.rows) || 24;
    const finalCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

    let ptyProcess;
    try {
      const args = ["/Q"];
      if (command) {
        args.push("/K", `chcp 65001>nul && ${command}`);
      } else {
        args.push("/K", "chcp 65001>nul");
      }

      ptyProcess = pty.spawn("cmd.exe", args, {
        cols: Math.max(20, cols),
        rows: Math.max(6, rows),
        cwd: finalCwd,
        env: { ...process.env, TERM: "xterm-256color" }
      });
    } catch (err) {
      event.sender.send(`cli-terminal:data:${tabId}`, `\r\n[启动终端失败: ${err.message}]\r\n`);
      return;
    }

    tabPtyProcesses.set(tabId, ptyProcess);

    ptyProcess.onData((data) => {
      event.sender.send(`cli-terminal:data:${tabId}`, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      tabPtyProcesses.delete(tabId);
      event.sender.send(`cli-terminal:data:${tabId}`, `\r\n[终端会话已退出，代码 ${exitCode ?? "未知"}]\r\n`);
    });
  });

  ipcMain.on("cli-terminal:input", (_event, tabId, data) => {
    const ptyProcess = tabPtyProcesses.get(tabId);
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  });

  ipcMain.on("cli-terminal:resize", (_event, tabId, size = {}) => {
    const ptyProcess = tabPtyProcesses.get(tabId);
    if (ptyProcess) {
      const cols = Math.max(20, Number(size.cols) || 80);
      const rows = Math.max(6, Number(size.rows) || 24);
      try {
        ptyProcess.resize(cols, rows);
      } catch {}
    }
  });
}

app.whenReady().then(async () => {
  setAppMenu();
  registerIpc();
  installEmbedHeaderFilter();
  installDownloadHandler();

  app.on("second-instance", (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      handleCommandLineArgs(commandLine);
    }
  });

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

  // Check if dragged onto icon on cold startup
  setTimeout(() => {
    handleCommandLineArgs(process.argv);
  }, 1500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopTerminal();
  stopLocalServer();
  for (const appInfo of runningDesktopApps.values()) {
    try {
      process.kill(appInfo.pid, 9);
    } catch {
      if (appInfo.child) {
        try { appInfo.child.kill(); } catch {}
      }
    }
  }
  runningDesktopApps.clear();
  for (const ptyProc of tabPtyProcesses.values()) {
    try { ptyProc.kill(); } catch {}
  }
  tabPtyProcesses.clear();
  if (process.platform !== "darwin") app.quit();
});
