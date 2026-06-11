const { app, BrowserWindow, ipcMain, session, shell, Menu, dialog, nativeImage } = require("electron");
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

function isAttachConsoleError(error) {
  return /AttachConsole failed/i.test(String(error?.message || error || ""));
}

function reportTerminalError(error, channel = "terminal:data") {
  const message = error?.message || String(error);
  console.warn("Terminal initialization failed:", message);
  sendToRenderer(channel, `\r\n[启动终端失败: ${message}]\r\n`);
}

process.on("uncaughtException", (error) => {
  if (isAttachConsoleError(error)) {
    reportTerminalError(error);
    return;
  }
  console.error("Unhandled main process exception:", error);
  throw error;
});


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
  try {
    terminalProcess = pty.spawn("cmd.exe", ["/Q", "/K", "chcp 65001>nul"], {
      cols: lastTerminalSize.cols,
      rows: lastTerminalSize.rows,
      cwd: os.homedir(),
      env: { ...process.env, TERM: "xterm-256color" }
    });
  } catch (error) {
    terminalProcess = null;
    reportTerminalError(error);
    return;
  }

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

// ===== 上传拦截（缺陷 #2 重做）：CDP Page.setInterceptFileChooserDialog =====
// 旧实现监听 webview 的 select-file-dialog 事件，该事件不在 Electron 36 官方事件列表中，从未触发。
// 新机制：活动任务期间对所有 webview webContents attach debugger 并开启 fileChooser 拦截；
// Page.fileChooserOpened 事件转发 renderer 弹工作台浮层，选择结果用 DOM.setFileInputFiles 注入。
// 任一环节异常 → 降级为主进程系统选择器注入，保证上传按钮不会点了没反应。
const webviewContentsSet = new Set();
const pendingUploadRequests = new Map();
let uploadRequestSeq = 0;
let uploadInterceptionEnabled = false;

function setWebviewFileChooserInterception(contents, enabled) {
  if (contents.isDestroyed()) return;
  try {
    if (enabled) {
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach("1.3");
        contents.debugger.on("message", (_event, method, params) => {
          if (method === "Page.fileChooserOpened") {
            handleFileChooserOpened(contents, params);
          }
        });
      }
      contents.debugger.sendCommand("Page.enable").catch(() => {});
      contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }).catch((error) => {
        console.warn("开启上传拦截失败，保持系统选择器:", error);
      });
    } else if (contents.debugger.isAttached()) {
      contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  } catch (error) {
    // attach 失败（如 devtools 占用）：不拦截，webview 走原生系统选择器，属于自然降级
    console.warn("上传拦截 debugger 操作失败，降级系统选择器:", error);
  }
}

function refreshUploadInterception() {
  const enabled = Boolean(activeTaskFolder);
  if (enabled === uploadInterceptionEnabled) return;
  uploadInterceptionEnabled = enabled;
  for (const contents of webviewContentsSet) {
    setWebviewFileChooserInterception(contents, enabled);
  }
}

function registerWebviewContents(contents) {
  webviewContentsSet.add(contents);
  contents.once("destroyed", () => {
    webviewContentsSet.delete(contents);
  });
  if (uploadInterceptionEnabled) {
    setWebviewFileChooserInterception(contents, true);
  }
}

async function injectUploadFiles(contents, backendNodeId, paths) {
  if (!Array.isArray(paths) || !paths.length) return { ok: true, injected: 0 };
  await contents.debugger.sendCommand("DOM.setFileInputFiles", {
    files: paths.map((item) => String(item)),
    backendNodeId
  });
  return { ok: true, injected: paths.length };
}

// 降级路径：浮层流程不可用时，直接弹系统选择器并注入，绝不让上传点击无响应
async function fallbackSystemChooser(contents, backendNodeId, mode) {
  try {
    const properties = ["openFile"];
    if (mode === "selectMultiple") properties.push("multiSelections");
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, { properties });
    if (result.canceled || !result.filePaths.length) return;
    await injectUploadFiles(contents, backendNodeId, result.filePaths);
  } catch (error) {
    console.error("上传降级系统选择器失败:", error);
  }
}

function handleFileChooserOpened(contents, params = {}) {
  const backendNodeId = params.backendNodeId;
  if (!backendNodeId) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    fallbackSystemChooser(contents, backendNodeId, params.mode);
    return;
  }
  uploadRequestSeq += 1;
  const requestId = uploadRequestSeq;
  pendingUploadRequests.set(requestId, { contents, backendNodeId, mode: params.mode });
  try {
    sendToRenderer("upload:choose-files", { requestId, mode: params.mode || "selectSingle" });
  } catch (error) {
    console.warn("上传拦截转发 renderer 失败，降级系统选择器:", error);
    pendingUploadRequests.delete(requestId);
    fallbackSystemChooser(contents, backendNodeId, params.mode);
  }
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
      
      const resolvedBase = path.resolve(baseDir);
      const targetPath = path.resolve(resolvedBase, relPath);
      const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
      if (targetPath !== resolvedBase && !targetPath.startsWith(baseWithSep)) {
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

// 已登记的测试页/评估页域名常量表（缺陷 #5）：仅这些来源的下载才允许走
// dialogue.json / eval_report 特殊归档与流水线推进；其余一切下载按通用规则处理
const PIPELINE_SOURCE_HOSTS = ["wl363eval.top"];

function isPipelineSourceUrl(rawUrl) {
  let candidate = String(rawUrl || "");
  if (candidate.startsWith("blob:")) candidate = candidate.slice(5);
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    return PIPELINE_SOURCE_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`));
  } catch {
    return false;
  }
}

function classifyDownload(filename, fromPipelineSource = false) {
  const lowerName = filename.toLowerCase();
  if (fromPipelineSource) {
    if (/\.(json|txt|md)$/i.test(filename) || lowerName.includes("chat") || lowerName.includes("dialog")) {
      return { type: "chat", folder: "chats" };
    }
    if (/\.(pdf|html?)$/i.test(filename) || lowerName.includes("report") || lowerName.includes("eval")) {
      return { type: "report", folder: "reports" };
    }
  }
  return { type: "generic", folder: "downloads" };
}

// 工作台偏好：裁切方向 + 像素数，持久化到 userData/workbench-prefs.json
function workbenchPrefsPath() {
  return path.join(app.getPath("userData"), "workbench-prefs.json");
}

function normalizeWorkbenchPrefs(prefs = {}) {
  const side = ["bottom", "top", "right"].includes(prefs.cropSide) ? prefs.cropSide : "bottom";
  const pixels = Math.max(1, Math.min(2000, Math.round(Number(prefs.cropPixels) || 100)));
  const todoFilePath = typeof prefs.todoFilePath === "string" ? prefs.todoFilePath : "";
  return { cropSide: side, cropPixels: pixels, todoFilePath };
}

function saveWorkbenchPrefs(prefs) {
  const normalized = normalizeWorkbenchPrefs(prefs);
  try {
    fs.writeFileSync(workbenchPrefsPath(), JSON.stringify(normalized, null, 2));
  } catch (error) {
    console.warn("保存工作台偏好失败:", error);
  }
  return normalized;
}

function loadWorkbenchPrefs() {
  try {
    return normalizeWorkbenchPrefs(JSON.parse(fs.readFileSync(workbenchPrefsPath(), "utf8")));
  } catch {
    return { cropSide: "bottom", cropPixels: 100 };
  }
}

// temp/tasks 防穿越校验：合法返回绝对路径，否则返回 null（所有任务文件 IPC 统一走这里）
function resolveTaskPath(candidate) {
  const tasksRoot = path.resolve(downloadRoot, "tasks");
  const target = path.resolve(String(candidate || ""));
  if (target !== tasksRoot && !target.startsWith(`${tasksRoot}${path.sep}`)) return null;
  return target;
}

function cleanupTaskFolder(folderPath) {
  const target = resolveTaskPath(folderPath);
  if (!target || target === path.resolve(downloadRoot, "tasks")) return false;
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  if (activeTaskFolder && path.resolve(activeTaskFolder) === target) {
    activeTaskFolder = "";
    watchActiveTaskFolder();
    refreshUploadInterception();
  }
  return true;
}

// 活动任务文件夹监听：500ms 防抖推送托盘刷新
let taskFolderWatcher = null;
let taskFolderWatchTimer = null;
function watchActiveTaskFolder() {
  if (taskFolderWatcher) {
    try { taskFolderWatcher.close(); } catch {}
    taskFolderWatcher = null;
  }
  clearTimeout(taskFolderWatchTimer);
  if (!activeTaskFolder || !fs.existsSync(activeTaskFolder)) return;
  try {
    taskFolderWatcher = fs.watch(activeTaskFolder, { recursive: true }, () => {
      clearTimeout(taskFolderWatchTimer);
      taskFolderWatchTimer = setTimeout(() => {
        sendToRenderer("task-folder-changed", { folderPath: activeTaskFolder });
      }, 500);
    });
  } catch (error) {
    console.warn("监听任务文件夹失败:", error);
  }
}

// 重名文件追加 " (2)"、" (3)" 后缀
function dedupeFileName(dir, filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  let candidate = filename;
  let counter = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${counter})${extension}`;
    counter += 1;
  }
  return candidate;
}

function installDownloadHandler() {
  workbenchSession().on("will-download", (_event, item, webContents) => {
    const filename = safeDownloadName(item.getFilename());
    let pageUrl = "";
    try {
      pageUrl = webContents?.getURL?.() || "";
    } catch {}
    const fromPipelineSource = isPipelineSourceUrl(item.getURL()) || isPipelineSourceUrl(pageUrl);
    const classification = classifyDownload(filename, fromPipelineSource);
    const extension = path.extname(filename) || ".bin";
    let saveDir;
    let archiveName;
    if (activeTaskFolder) {
      // 活动任务期间：所有下载汇入任务文件夹；eval_report/dialogue 特殊归档命名优先
      saveDir = activeTaskFolder;
      fs.mkdirSync(saveDir, { recursive: true });
      archiveName = {
        chat: "dialogue.json",
        report: `eval_report${extension}`
      }[classification.type] || dedupeFileName(saveDir, filename);
    } else {
      // 无活动任务：行为与现状一致
      saveDir = path.join(downloadRoot, classification.folder);
      fs.mkdirSync(saveDir, { recursive: true });
      archiveName = {
        chat: "dialogue.json",
        report: `eval_report${extension}`
      }[classification.type] || `${Date.now()}_${filename}`;
    }
    const savePath = path.join(saveDir, archiveName);
    item.setSavePath(savePath);

    const captured = Boolean(activeTaskFolder);
    item.once("done", (_doneEvent, state) => {
      if (state !== "completed") return;
      sendToRenderer("download-completed", {
        type: classification.type,
        path: savePath,
        filename,
        captured
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
    // 活动任务文件夹必须位于 temp/tasks 下，非法路径一律视为无活动任务
    const validated = info.folderPath ? resolveTaskPath(info.folderPath) : null;
    activeTaskFolder = validated && fs.existsSync(validated) ? validated : "";
    watchActiveTaskFolder();
    refreshUploadInterception();
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
    watchActiveTaskFolder();
    refreshUploadInterception();
    broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
    return folderPath;
  });
  // 上传拦截浮层结果回传：paths 为空 = 用户取消（不注入，等同原生取消）
  ipcMain.handle("upload:resolve-files", async (_event, requestId, paths) => {
    const request = pendingUploadRequests.get(Number(requestId));
    if (!request) return { ok: false, error: "请求不存在或已处理" };
    pendingUploadRequests.delete(Number(requestId));
    if (request.contents.isDestroyed()) return { ok: false, error: "页面已关闭" };
    try {
      return await injectUploadFiles(request.contents, request.backendNodeId, paths);
    } catch (error) {
      console.error("上传文件注入失败:", error);
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("tasks:cleanup-folder", (_event, folderPath) => {
    const res = cleanupTaskFolder(folderPath);
    broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
    return res;
  });
  // 打开任务产物文件夹：仅允许 temp/tasks 下的路径，防止路径穿越
  ipcMain.handle("tasks:open-folder", (_event, folderPath) => {
    const target = resolveTaskPath(folderPath);
    if (!target || !fs.existsSync(target)) return false;
    shell.openPath(target);
    return true;
  });
  // 列出任务文件夹内文件名（任务舱产物检测用），同样限制在 temp/tasks 内
  ipcMain.handle("tasks:list-folder", (_event, folderPath) => {
    const target = resolveTaskPath(folderPath);
    if (!target || !fs.existsSync(target)) return [];
    try {
      return fs.readdirSync(target);
    } catch {
      return [];
    }
  });
  // 托盘文件列表：任务文件夹下全部文件（子文件夹仅展开一层，不递归深层）
  ipcMain.handle("tasks:list-files", (_event, folderPath) => {
    const target = resolveTaskPath(folderPath);
    if (!target || !fs.existsSync(target)) return [];
    const entries = [];
    const pushFile = (absPath, relPath) => {
      try {
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) return;
        entries.push({ name: path.basename(absPath), relPath, path: absPath, size: stat.size, mtime: stat.mtimeMs });
      } catch {}
    };
    try {
      for (const entry of fs.readdirSync(target)) {
        const absPath = path.join(target, entry);
        let stat;
        try { stat = fs.statSync(absPath); } catch { continue; }
        if (stat.isDirectory()) {
          try {
            for (const child of fs.readdirSync(absPath)) {
              pushFile(path.join(absPath, child), `${entry}/${child}`);
            }
          } catch {}
        } else {
          pushFile(absPath, entry);
        }
      }
    } catch {}
    return entries;
  });
  // 上传浮层 fallback：系统文件选择器（用户主动选择，结果直接回注 webview）
  ipcMain.handle("dialog:pick-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"]
    });
    return result.canceled ? [] : result.filePaths;
  });
  // 工作台偏好：读取 / 保存（持久化到 userData）
  ipcMain.handle("prefs:get-workbench", () => loadWorkbenchPrefs());
  ipcMain.handle("prefs:set-workbench", (_event, prefs) => {
    // 合并保存：renderer 只传部分字段时不丢其余偏好（如 todoFilePath）
    return saveWorkbenchPrefs({ ...loadWorkbenchPrefs(), ...prefs });
  });
  // 选择待做任务.txt：系统对话框定位后写入偏好，之后一键直读
  ipcMain.handle("dialog:pick-todo-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "文本文件", extensions: ["txt"] }]
    });
    if (result.canceled || !result.filePaths.length) return "";
    const picked = result.filePaths[0];
    saveWorkbenchPrefs({ ...loadWorkbenchPrefs(), todoFilePath: picked });
    return picked;
  });
  // 读取待做任务.txt：只允许读偏好中登记的这一个路径；UTF-8 + BOM 兼容；
  // 出现替换字符（U+FFFD）视为非 UTF-8 编码，提示用户转存，不做 GBK 转码（范围外）
  ipcMain.handle("tasks:read-todo-file", () => {
    const todoPath = loadWorkbenchPrefs().todoFilePath;
    if (!todoPath) return { ok: false, error: "not-configured" };
    if (!fs.existsSync(todoPath)) return { ok: false, error: "not-found", path: todoPath };
    let text;
    try {
      text = fs.readFileSync(todoPath, "utf8");
    } catch (error) {
      return { ok: false, error: `读取失败: ${error.message}`, path: todoPath };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.includes("\uFFFD")) return { ok: false, error: "encoding", path: todoPath };
    return { ok: true, text, path: todoPath };
  });
  // 图片裁切去水印：nativeImage 实现，生成 原名_cropped 新文件，原图保留
  ipcMain.handle("tasks:crop-image", (_event, filePath) => {
    const target = resolveTaskPath(filePath);
    if (!target || !fs.existsSync(target)) return { ok: false, error: "文件不存在或越出任务目录" };
    if (!/\.(png|jpe?g|webp)$/i.test(target)) return { ok: false, error: "仅支持 png/jpg/jpeg/webp 图片" };
    const prefs = loadWorkbenchPrefs();
    const image = nativeImage.createFromPath(target);
    if (image.isEmpty()) return { ok: false, error: "图片读取失败" };
    const { width, height } = image.getSize();
    const limit = prefs.cropSide === "right" ? width : height;
    const pixels = Math.min(prefs.cropPixels, limit - 1);
    if (pixels <= 0) return { ok: false, error: "图片尺寸过小，无法裁切" };
    const rect = { x: 0, y: 0, width, height };
    if (prefs.cropSide === "bottom") rect.height = height - pixels;
    else if (prefs.cropSide === "top") { rect.y = pixels; rect.height = height - pixels; }
    else rect.width = width - pixels;
    const cropped = image.crop(rect);
    const extension = path.extname(target);
    // nativeImage 无法编码 webp，webp 源输出为 png
    const outExtension = /\.jpe?g$/i.test(extension) ? extension : /\.webp$/i.test(extension) ? ".png" : extension;
    const outPath = path.join(path.dirname(target), `${path.basename(target, extension)}_cropped${outExtension}`);
    const buffer = /\.jpe?g$/i.test(outExtension) ? cropped.toJPEG(90) : cropped.toPNG();
    try {
      fs.writeFileSync(outPath, buffer);
    } catch (error) {
      return { ok: false, error: `写入失败: ${error.message}` };
    }
    return { ok: true, path: outPath };
  });
  // 托盘文件操作：打开 / 资源管理器定位 / 删除，全部限制在 temp/tasks 内
  ipcMain.handle("tasks:file-action", (_event, payload = {}) => {
    const target = resolveTaskPath(payload.filePath);
    if (!target || target === path.resolve(downloadRoot, "tasks") || !fs.existsSync(target)) return false;
    const action = String(payload.action || "");
    if (action === "open") {
      shell.openPath(target);
      return true;
    }
    if (action === "reveal") {
      shell.showItemInFolder(target);
      return true;
    }
    if (action === "delete") {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    }
    return false;
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
      registerWebviewContents(contents);
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
