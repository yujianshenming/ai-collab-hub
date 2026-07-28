const { app, BrowserWindow, ipcMain, session, shell, Menu, dialog, nativeImage, clipboard, Notification } = require("electron");
const pty = require("node-pty");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, exec } = require("node:child_process");

if (process.env.PERSONAL_WORKBENCH_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.PERSONAL_WORKBENCH_USER_DATA));
}

// Windows 系统通知需要固定 AppUserModelId（与 package.json build.appId 对齐）
if (process.platform === "win32") {
  app.setAppUserModelId("com.personal.workbench");
}

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
let activeTaskId = "";
let activeTaskStep = "idle";
let activeTaskSchool = "";
let activeTaskCourse = "";
const localAppsMap = new Map();
const localAppAccessTokens = new Map();
const localAppTokensByTabId = new Map();
const runningDesktopApps = new Map();
const tabPtyProcesses = new Map();
const embeddedWindows = new Map();
const embeddedWindowRects = new Map();
const embeddedWindowPendingRects = new Map();
const inFlightDownloadPaths = new Set();
const extensionAccessTokens = new Map();
const extensionCapabilities = new Map();
const loadedExtensionTokens = new Map();
const tokenboxBridge = {
  child: null,
  path: "",
  buffer: "",
  nextId: 1,
  pending: new Map(),
  lastError: "",
  stopping: false
};
const TOKENBOX_BRIDGE_REQUEST_TIMEOUT_MS = 120000;
const TOKENBOX_BRIDGE_MAX_LINE_BYTES = 8 * 1024 * 1024;
const homeworkVarianceService = {
  child: null,
  root: "",
  dataRoot: "",
  port: 0,
  token: "",
  output: "",
  lastError: "",
  lastErrorDetail: null,
  starting: null,
  generation: 0
};
const HOMEWORK_VARIANCE_READY_TIMEOUT_MS = 45000;
const HOMEWORK_VARIANCE_LOG_BYTES = 16 * 1024;

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
  const child = spawn("powershell.exe", args);
  child.on("error", (error) => console.warn("Window binder failed:", error));
  return child;
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
        if (DESKTOP_APP_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
          const approvedPath = approveDesktopAppPath(targetPath);
          if (!approvedPath) return;
          targetPath = approvedPath;
        }
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
const configuredLocalServerPort = Number(process.env.PERSONAL_WORKBENCH_LOCAL_SERVER_PORT);
const localServerPort = Number.isInteger(configuredLocalServerPort)
  && configuredLocalServerPort >= 1024
  && configuredLocalServerPort <= 65535
  ? configuredLocalServerPort
  : 38924;
const extensionApiBaseUrl = "https://cloudapi.polymas.com";
const extensionAuthCookieUrl = "https://hike-teaching-center.polymas.com/";
const extensionAuthCookieName = "ai-poly";
const LOCAL_APP_ALLOWED_ROUTES = new Set([
  "/events",
  "/broadcast",
  "/state",
  "/tabs",
  "/active-tab",
  "/active-task"
]);
const DESKTOP_APP_EXTENSIONS = new Set([".exe", ".com", ".bat", ".cmd"]);
const desktopAppAllowlist = new Set();
const downloadRoot = process.env.PERSONAL_WORKBENCH_DOWNLOAD_ROOT
  ? path.resolve(process.env.PERSONAL_WORKBENCH_DOWNLOAD_ROOT)
  : path.join(__dirname, "temp");
const weeklyTasksPath = process.env.PERSONAL_WORKBENCH_WEEKLY_TASKS_PATH
  ? path.resolve(process.env.PERSONAL_WORKBENCH_WEEKLY_TASKS_PATH)
  : path.join(__dirname, "..", "tasks", "weekly_tasks.json");
let localServerStatus = { port: localServerPort, running: false, error: "" };

function weeklyReportsPath() {
  return path.join(app.getPath("userData"), "weekly-reports.json");
}

function workbenchSession() {
  return session.fromPartition(workbenchPartition);
}

function extensionDebugLog(event, details = {}) {
  try {
    const logPath = path.join(app.getPath("userData"), "extension-debug.log");
    const line = JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...details
    });
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {}
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

function updateLocalServerStatus(patch = {}) {
  localServerStatus = { ...localServerStatus, ...patch, port: localServerPort };
  sendToRenderer("local-server:status", { ...localServerStatus });
}

function desktopAppAllowlistPath() {
  return path.join(app.getPath("userData"), "desktop-app-allowlist.json");
}

function desktopAppPathKey(filePath) {
  return path.normalize(String(filePath || "")).toLowerCase();
}

function canonicalDesktopAppPath(candidate) {
  const raw = String(candidate || "").trim();
  if (!raw || !path.isAbsolute(raw)) return "";
  try {
    const realPath = fs.realpathSync(raw);
    const stat = fs.statSync(realPath);
    if (!stat.isFile() || !DESKTOP_APP_EXTENSIONS.has(path.extname(realPath).toLowerCase())) return "";
    return realPath;
  } catch {
    return "";
  }
}

function loadDesktopAppAllowlist() {
  desktopAppAllowlist.clear();
  try {
    const saved = JSON.parse(fs.readFileSync(desktopAppAllowlistPath(), "utf8"));
    if (!Array.isArray(saved)) return;
    for (const candidate of saved) {
      const realPath = canonicalDesktopAppPath(candidate);
      if (realPath) desktopAppAllowlist.add(desktopAppPathKey(realPath));
    }
  } catch {}
}

function saveDesktopAppAllowlist() {
  try {
    const entries = [...desktopAppAllowlist].sort();
    fs.mkdirSync(path.dirname(desktopAppAllowlistPath()), { recursive: true });
    fs.writeFileSync(desktopAppAllowlistPath(), JSON.stringify(entries, null, 2), "utf8");
  } catch (error) {
    console.warn("保存桌面程序登记表失败:", error);
  }
}

function approveDesktopAppPath(candidate) {
  const realPath = canonicalDesktopAppPath(candidate);
  if (!realPath) return "";
  desktopAppAllowlist.add(desktopAppPathKey(realPath));
  saveDesktopAppAllowlist();
  return realPath;
}

function isApprovedDesktopAppPath(candidate) {
  const realPath = canonicalDesktopAppPath(candidate);
  return realPath && desktopAppAllowlist.has(desktopAppPathKey(realPath)) ? realPath : "";
}

function tokenboxBridgeCandidates() {
  return [...new Set([
    process.env.TOKENBOX_BRIDGE_PATH,
    path.join(app.isPackaged ? process.resourcesPath : __dirname, "sidecars", "tokenbox-bridge.exe"),
    path.resolve(__dirname, "..", "..", "tokenbox", "src-tauri", "target", "release", "tokenbox-bridge.exe"),
    path.resolve(__dirname, "..", "..", "tokenbox", "src-tauri", "target", "x86_64-pc-windows-gnu", "release", "tokenbox-bridge.exe")
  ].filter(Boolean))];
}

function resolveTokenboxBridgePath() {
  for (const candidate of tokenboxBridgeCandidates()) {
    try {
      if (path.extname(candidate).toLowerCase() === ".exe" && fs.statSync(candidate).isFile()) {
        return path.resolve(candidate);
      }
    } catch {}
  }
  return "";
}

function rejectTokenboxBridgePending(error) {
  for (const [id, request] of tokenboxBridge.pending) {
    clearTimeout(request.timer);
    request.reject(error);
    tokenboxBridge.pending.delete(id);
  }
}

function closeTokenboxBridge() {
  const child = tokenboxBridge.child;
  tokenboxBridge.stopping = true;
  tokenboxBridge.child = null;
  tokenboxBridge.buffer = "";
  if (!child) return;
  rejectTokenboxBridgePending(new Error("TokenBox bridge stopped"));
  try {
    child.kill();
  } catch {}
}

function handleTokenboxBridgeOutput(chunk) {
  tokenboxBridge.buffer += String(chunk);
  if (Buffer.byteLength(tokenboxBridge.buffer, "utf8") > TOKENBOX_BRIDGE_MAX_LINE_BYTES * 2) {
    tokenboxBridge.lastError = "TokenBox bridge response buffer exceeded the safety limit";
    closeTokenboxBridge();
    return;
  }
  let newlineIndex;
  while ((newlineIndex = tokenboxBridge.buffer.indexOf("\n")) >= 0) {
    const line = tokenboxBridge.buffer.slice(0, newlineIndex).trim();
    tokenboxBridge.buffer = tokenboxBridge.buffer.slice(newlineIndex + 1);
    if (!line) continue;
    if (Buffer.byteLength(line, "utf8") > TOKENBOX_BRIDGE_MAX_LINE_BYTES) {
      tokenboxBridge.lastError = "TokenBox bridge response line exceeded the safety limit";
      closeTokenboxBridge();
      return;
    }
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      tokenboxBridge.lastError = `TokenBox bridge returned invalid JSON: ${error.message}`;
      continue;
    }
    const request = tokenboxBridge.pending.get(response?.id);
    if (!request) continue;
    tokenboxBridge.pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error || "TokenBox bridge request failed"));
  }
}

function startTokenboxBridge() {
  if (tokenboxBridge.child && !tokenboxBridge.child.killed) return tokenboxBridge.child;
  const bridgePath = resolveTokenboxBridgePath();
  if (!bridgePath) {
    throw new Error("找不到 tokenbox-bridge.exe，请先构建 TokenBox sidecar 或设置 TOKENBOX_BRIDGE_PATH");
  }
  const child = spawn(bridgePath, [], {
    cwd: path.dirname(bridgePath),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  tokenboxBridge.child = child;
  tokenboxBridge.path = bridgePath;
  tokenboxBridge.buffer = "";
  tokenboxBridge.lastError = "";
  tokenboxBridge.stopping = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", handleTokenboxBridgeOutput);
  child.stderr.on("data", (chunk) => {
    tokenboxBridge.lastError = String(chunk).trim().slice(-2000);
  });
  child.on("error", (error) => {
    tokenboxBridge.lastError = error.message;
    if (tokenboxBridge.child === child) {
      tokenboxBridge.child = null;
      rejectTokenboxBridgePending(error);
    }
  });
  child.on("exit", (code, signal) => {
    if (tokenboxBridge.child !== child) return;
    tokenboxBridge.child = null;
    if (!tokenboxBridge.stopping && code !== 0) {
      tokenboxBridge.lastError = `TokenBox bridge exited unexpectedly (${code ?? signal ?? "unknown"})`;
    }
    rejectTokenboxBridgePending(new Error(tokenboxBridge.lastError || "TokenBox bridge exited"));
  });
  return child;
}

function requestTokenboxBridge(method, params = {}) {
  const child = startTokenboxBridge();
  const id = tokenboxBridge.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tokenboxBridge.pending.delete(id);
      reject(new Error(`TokenBox bridge request timed out: ${method}`));
    }, TOKENBOX_BRIDGE_REQUEST_TIMEOUT_MS);
    tokenboxBridge.pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const request = tokenboxBridge.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        tokenboxBridge.pending.delete(id);
        request.reject(error);
      });
    } catch (error) {
      clearTimeout(timer);
      tokenboxBridge.pending.delete(id);
      reject(error);
    }
  });
}

function tokenboxBridgeStatus() {
  const bridgePath = resolveTokenboxBridgePath();
  return {
    available: Boolean(bridgePath),
    running: Boolean(tokenboxBridge.child && !tokenboxBridge.child.killed),
    path: bridgePath || tokenboxBridge.path,
    error: tokenboxBridge.lastError
  };
}

function homeworkVarianceRootCandidates() {
  return [...new Set([
    process.env.PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_ROOT,
    app.isPackaged ? path.join(process.resourcesPath, "integrations", "homework-variance") : "",
    path.join(__dirname, "integrations", "homework-variance")
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

function resolveHomeworkVarianceRoot() {
  for (const candidate of homeworkVarianceRootCandidates()) {
    try {
      if (fs.statSync(path.join(candidate, "web_server.py")).isFile()
        && fs.statSync(path.join(candidate, "polymas_grade_engine.py")).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return "";
}

function homeworkVarianceStatus() {
  const root = homeworkVarianceService.root || resolveHomeworkVarianceRoot();
  return {
    available: Boolean(root),
    running: Boolean(homeworkVarianceService.child && !homeworkVarianceService.child.killed),
    root,
    dataRoot: homeworkVarianceService.dataRoot,
    port: homeworkVarianceService.port,
    error: homeworkVarianceService.lastError,
    errorDetail: homeworkVarianceService.lastErrorDetail
  };
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function probeHomeworkVarianceHealth(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/health",
      timeout: 1200
    }, (response) => {
      response.resume();
      finish(response.statusCode === 200);
    });
    request.on("error", () => finish(false));
    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
  });
}

async function waitForHomeworkVarianceHealth(port, child, generation) {
  const deadline = Date.now() + HOMEWORK_VARIANCE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (generation !== homeworkVarianceService.generation) {
      throw new Error("作业批阅服务启动已取消");
    }
    if (child.exitCode !== null || child.killed) {
      throw new Error(homeworkVarianceService.lastError || "作业批阅服务提前退出");
    }
    if (await probeHomeworkVarianceHealth(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`作业批阅服务启动超时：${homeworkVarianceService.output.slice(-600)}`);
}

function homeworkVariancePythonCandidates() {
  const configured = String(process.env.PERSONAL_WORKBENCH_PYTHON || "").trim();
  const candidates = [];
  if (configured) candidates.push({ command: configured, prefix: [] });
  candidates.push({ command: process.platform === "win32" ? "python.exe" : "python3", prefix: [] });
  candidates.push({ command: "python", prefix: [] });
  if (process.platform === "win32") candidates.push({ command: "py", prefix: ["-3"] });
  return candidates;
}

function spawnHomeworkVariancePython(root, args, env) {
  const candidates = homeworkVariancePythonCandidates();
  let index = 0;
  const attempt = () => {
    if (index >= candidates.length) {
      throw new Error("找不到 Python 解释器，请安装 Python 3.10+ 或设置 PERSONAL_WORKBENCH_PYTHON");
    }
    const candidate = candidates[index++];
    return new Promise((resolve, reject) => {
      const child = spawn(candidate.command, [...candidate.prefix, ...args], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let spawned = false;
      child.once("spawn", () => {
        spawned = true;
        resolve(child);
      });
      child.once("error", (error) => {
        if (!spawned) reject(error);
      });
    }).catch((error) => {
      if (error?.code === "ENOENT") return attempt();
      throw error;
    });
  };
  return attempt();
}

function killHomeworkVarianceProcessTree(child) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => {});
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function appendHomeworkVarianceOutput(chunk) {
  homeworkVarianceService.output = `${homeworkVarianceService.output}${String(chunk)}`.slice(-HOMEWORK_VARIANCE_LOG_BYTES);
}

function homeworkVarianceLogDir() {
  const dataRoot = homeworkVarianceService.dataRoot || path.join(app.getPath("userData"), "homework-variance");
  return path.join(dataRoot, "logs");
}

function writeHomeworkVarianceLogLine(entry) {
  try {
    const dir = homeworkVarianceLogDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "homework-variance-service.log"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

function reportHomeworkVarianceError(stage, error, extra = {}) {
  const message = (error?.message || String(error || "")).trim();
  const detail = {
    timestamp: new Date().toISOString(),
    level: "error",
    service: "homework-variance",
    stage,
    message,
    code: error?.code ?? null,
    stack: typeof error?.stack === "string" ? error.stack.slice(0, 4000) : null,
    port: homeworkVarianceService.port || null,
    outputTail: homeworkVarianceService.output.slice(-2000),
    ...extra
  };
  homeworkVarianceService.lastError = message;
  homeworkVarianceService.lastErrorDetail = detail;
  writeHomeworkVarianceLogLine(detail);
  return detail;
}

function stopHomeworkVariance() {
  homeworkVarianceService.generation += 1;
  const child = homeworkVarianceService.child;
  homeworkVarianceService.child = null;
  homeworkVarianceService.port = 0;
  homeworkVarianceService.token = "";
  if (child) killHomeworkVarianceProcessTree(child);
}

async function startHomeworkVariance() {
  if (homeworkVarianceService.child && !homeworkVarianceService.child.killed) {
    return {
      success: true,
      url: `http://127.0.0.1:${homeworkVarianceService.port}/?token=${encodeURIComponent(homeworkVarianceService.token)}`
    };
  }
  if (homeworkVarianceService.starting) return homeworkVarianceService.starting;

  const generation = homeworkVarianceService.generation + 1;
  homeworkVarianceService.generation = generation;
  const launch = (async () => {
    const root = resolveHomeworkVarianceRoot();
    if (!root) throw new Error("找不到作业批阅集成文件，请确认 integrations/homework-variance 已随应用安装");
    const port = await reserveLoopbackPort();
    const token = crypto.randomBytes(32).toString("hex");
    const dataRoot = path.join(app.getPath("userData"), "homework-variance");
    fs.mkdirSync(dataRoot, { recursive: true });
    const env = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_DATA: dataRoot,
      PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_TOKEN: token,
      PERSONAL_WORKBENCH_HOMEWORK_VARIANCE_SECRETS: path.join(dataRoot, "secrets.json")
    };
    const child = await spawnHomeworkVariancePython(root, [
      "-u",
      "web_server.py",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-root",
      dataRoot,
      "--auth-token",
      token
    ], env);
    if (generation !== homeworkVarianceService.generation) {
      killHomeworkVarianceProcessTree(child);
      throw new Error("作业批阅服务启动已取消");
    }
    homeworkVarianceService.child = child;
    homeworkVarianceService.root = root;
    homeworkVarianceService.dataRoot = dataRoot;
    homeworkVarianceService.port = port;
    homeworkVarianceService.token = token;
    homeworkVarianceService.output = "";
    homeworkVarianceService.lastError = "";
    homeworkVarianceService.lastErrorDetail = null;
    writeHomeworkVarianceLogLine({
      timestamp: new Date().toISOString(),
      level: "info",
      service: "homework-variance",
      stage: "spawn",
      message: `作业批阅侧车已启动 (pid=${child.pid ?? "unknown"}, port=${port})`
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", appendHomeworkVarianceOutput);
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      appendHomeworkVarianceOutput(text);
      if (/(error|traceback|exception|failed|fatal)/i.test(text)) {
        reportHomeworkVarianceError("runtime-stderr", new Error(text.trim().slice(-2000)));
      }
    });
    child.on("error", (error) => {
      reportHomeworkVarianceError("process-error", error);
    });
    child.on("exit", (code, signal) => {
      if (homeworkVarianceService.child !== child) return;
      if (code !== 0 && code !== null) {
        reportHomeworkVarianceError("process-exit", new Error(`作业批阅服务退出 (${code ?? signal ?? "unknown"})`), {
          exitCode: code,
          signal: signal ?? null
        });
      }
      homeworkVarianceService.child = null;
      homeworkVarianceService.port = 0;
      homeworkVarianceService.token = "";
    });
    await waitForHomeworkVarianceHealth(port, child, generation);
    return {
      success: true,
      url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
    };
  })();
  homeworkVarianceService.starting = launch;
  try {
    return await launch;
  } catch (error) {
    const detail = reportHomeworkVarianceError("startup", error);
    stopHomeworkVariance();
    return { success: false, error: homeworkVarianceService.lastError, errorDetail: detail };
  } finally {
    if (homeworkVarianceService.starting === launch) homeworkVarianceService.starting = null;
  }
}

function normalizeTokenboxFilter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TokenBox filter must be an object");
  }
  const normalized = {};
  const provider = String(value.provider || "").trim().toLowerCase();
  if (provider && !["all", "codex", "claude", "claude_code"].includes(provider)) {
    throw new Error("TokenBox provider is not supported");
  }
  if (provider && provider !== "all") normalized.provider = provider;
  for (const field of ["from", "to"]) {
    if (value[field] === undefined || value[field] === null || value[field] === "") continue;
    const date = String(value[field]).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`TokenBox ${field} must use YYYY-MM-DD`);
    }
    const [year, month, day] = date.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (year < 1 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      throw new Error(`TokenBox ${field} is not a valid date`);
    }
    normalized[field] = date;
  }
  return normalized;
}

function normalizeTokenboxFormat(value, allowed) {
  const format = String(value || "").trim().toLowerCase();
  if (!allowed.includes(format)) {
    throw new Error(`TokenBox format must be one of ${allowed.join(", ")}`);
  }
  return format;
}

function normalizeTokenboxModel(value) {
  const model = String(value || "").trim();
  if (!model) throw new Error("TokenBox model is required");
  if (model.length > 256) throw new Error("TokenBox model is too long");
  return model;
}

function normalizeTokenboxProvider(value, { allowEmpty = true } = {}) {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider && allowEmpty) return "";
  if (!["all", "codex", "claude", "claude_code"].includes(provider)) {
    throw new Error("TokenBox provider is not supported");
  }
  return provider;
}

function normalizeTokenboxSourceName(value) {
  const sourceName = String(value || "").trim();
  if (sourceName.length > 512) throw new Error("TokenBox source name is too long");
  return sourceName;
}

async function callTokenboxBridge(method, params = {}) {
  try {
    const result = await requestTokenboxBridge(method, params);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
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

  const startedTerminal = terminalProcess;
  startedTerminal.onData((data) => sendToRenderer("terminal:data", data));
  startedTerminal.onExit(({ exitCode }) => {
    if (terminalProcess !== startedTerminal) return;
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
const approvedUploadPaths = new Map();
const debuggerMessageHandlers = new WeakMap();
const appAttachedDebuggers = new WeakSet();
let uploadRequestSeq = 0;
let uploadInterceptionEnabled = false;
const UPLOAD_APPROVAL_TTL_MS = 2 * 60 * 1000;

function setWebviewFileChooserInterception(contents, enabled) {
  if (contents.isDestroyed()) return;
  try {
    if (enabled) {
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach("1.3");
        appAttachedDebuggers.add(contents);
      }
      if (!debuggerMessageHandlers.has(contents)) {
        const messageHandler = (_event, method, params) => {
          if (method === "Page.fileChooserOpened") {
            handleFileChooserOpened(contents, params);
          }
        };
        debuggerMessageHandlers.set(contents, messageHandler);
        contents.debugger.on("message", messageHandler);
      }
      contents.debugger.sendCommand("Page.enable").catch(() => {});
      contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }).catch((error) => {
        console.warn("开启上传拦截失败，保持系统选择器:", error);
      });
    } else if (contents.debugger.isAttached()) {
      contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      const messageHandler = debuggerMessageHandlers.get(contents);
      if (messageHandler) contents.debugger.removeListener("message", messageHandler);
      debuggerMessageHandlers.delete(contents);
      if (appAttachedDebuggers.has(contents)) {
        try { contents.debugger.detach(); } catch {}
        appAttachedDebuggers.delete(contents);
      }
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
    for (const [requestId, request] of pendingUploadRequests) {
      if (request.contents === contents) pendingUploadRequests.delete(requestId);
    }
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

function uploadPathKey(filePath) {
  return path.normalize(String(filePath || "")).toLowerCase();
}

function canonicalUploadFilePath(candidate) {
  const raw = String(candidate || "").trim();
  if (!raw) return "";
  try {
    const realPath = fs.realpathSync(raw);
    return fs.statSync(realPath).isFile() ? realPath : "";
  } catch {
    return "";
  }
}

function rememberApprovedUploadPaths(paths = []) {
  const now = Date.now();
  for (const candidate of Array.isArray(paths) ? paths : []) {
    const realPath = canonicalUploadFilePath(candidate);
    if (realPath) approvedUploadPaths.set(uploadPathKey(realPath), { path: realPath, approvedAt: now });
  }
}

function cleanupApprovedUploadPaths() {
  const cutoff = Date.now() - UPLOAD_APPROVAL_TTL_MS;
  for (const [key, entry] of approvedUploadPaths) {
    if (!entry || entry.approvedAt < cutoff || !fs.existsSync(entry.path)) approvedUploadPaths.delete(key);
  }
}

function validateUploadPaths(paths, taskFolder = "") {
  if (!Array.isArray(paths)) return { ok: false, error: "上传路径必须是数组" };
  if (!paths.length) return { ok: true, paths: [] };
  cleanupApprovedUploadPaths();
  const accepted = [];
  for (const candidate of paths) {
    const realPath = canonicalUploadFilePath(candidate);
    if (!realPath) return { ok: false, error: "上传文件不存在或不是文件" };
    const insideTaskFolder = Boolean(taskFolder && resolveContainedRealPath(taskFolder, realPath));
    const approval = approvedUploadPaths.get(uploadPathKey(realPath));
    if (!insideTaskFolder && !approval) {
      return { ok: false, error: "上传文件未通过工作台文件选择或当前任务目录校验" };
    }
    accepted.push(realPath);
  }
  return { ok: true, paths: accepted };
}

// 降级路径：浮层流程不可用时，直接弹系统选择器并注入，绝不让上传点击无响应
async function fallbackSystemChooser(contents, backendNodeId, mode) {
  try {
    const properties = ["openFile"];
    if (mode === "selectMultiple") properties.push("multiSelections");
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, { properties });
    if (result.canceled || !result.filePaths.length) return;
    rememberApprovedUploadPaths(result.filePaths);
    const validated = validateUploadPaths(result.filePaths, activeTaskFolder);
    if (validated.ok) await injectUploadFiles(contents, backendNodeId, validated.paths);
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
  pendingUploadRequests.set(requestId, {
    contents,
    backendNodeId,
    mode: params.mode,
    taskFolder: activeTaskFolder
  });
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
  if (!/^https?:\/\//i.test(String(filter.url || ""))) return [];
  try {
    return await workbenchSession().cookies.get(filter);
  } catch {
    return [];
  }
}

async function getExtensionAuth() {
  const cookies = await getWorkbenchCookies({ url: extensionAuthCookieUrl });
  const authorization = cookies.find((cookie) => cookie.name === extensionAuthCookieName)?.value || "";
  return {
    authorization,
    cookieHeader: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
  };
}

function resolveExtensionApiUrl(endpoint = "") {
  const resolved = new URL(String(endpoint || "/"), extensionApiBaseUrl);
  if (resolved.origin !== extensionApiBaseUrl) {
    throw new Error("Unsupported extension API origin");
  }
  return resolved.toString();
}

async function requestExtensionApi(payload = {}) {
  const { authorization, cookieHeader } = await getExtensionAuth();
  const endpoint = String(payload.endpoint || "");
  extensionDebugLog("api-request:start", {
    endpoint,
    method: payload.method || "GET",
    hasAuthorization: Boolean(authorization),
    cookieNames: cookieHeader
      ? cookieHeader.split(";").map((item) => item.trim().split("=")[0]).filter(Boolean)
      : [],
    bodyKeys: payload.body && typeof payload.body === "object" ? Object.keys(payload.body) : []
  });
  if (!authorization && !cookieHeader) {
    extensionDebugLog("api-request:no-auth", { endpoint });
    return { success: false, error: "Failed to get auth info" };
  }

  const headers = {
    "Content-Type": "application/json",
    ...(payload.headers && typeof payload.headers === "object" ? payload.headers : {})
  };
  if (authorization) headers.Authorization = authorization;
  if (cookieHeader) headers.Cookie = cookieHeader;

  try {
    const requestUrl = resolveExtensionApiUrl(endpoint);
    const response = await fetch(requestUrl, {
      method: payload.method || "GET",
      headers,
      body: payload.body ? JSON.stringify(payload.body) : undefined
    });
    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {}
    extensionDebugLog("api-request:response", {
      endpoint,
      status: response.status,
      ok: response.ok,
      responseKeys: data && typeof data === "object" ? Object.keys(data) : [],
      dataType: Array.isArray(data?.data) ? "data-array" : typeof data?.data,
      dataLength: Array.isArray(data?.data) ? data.data.length : null,
      code: data?.code ?? data?.status ?? null,
      message: data?.message ?? data?.msg ?? data?.error ?? null,
      textPreview: rawText.slice(0, 300)
    });
    if (!response.ok) return { success: false, error: `HTTP error: ${response.status}` };
    return { success: true, data };
  } catch (error) {
    extensionDebugLog("api-request:error", { endpoint, error: error?.message || String(error) });
    return { success: false, error: error?.message || String(error) };
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

function tokenCanAccessRoute(token, route) {
  if (token === sessionToken) return true;
  const localAppCapabilities = localAppAccessTokens.get(token);
  if (localAppCapabilities) return localAppCapabilities.routes.has(route);
  const capabilities = extensionAccessTokens.get(token);
  if (!capabilities) return false;
  if (route === "/active-tab") return Boolean(capabilities.tabs);
  if (route === "/cookies") return Boolean(capabilities.cookies);
  if (route === "/extension-debug-log") return true;
  return false;
}

function extensionCanAccessUrl(capabilities, rawUrl) {
  if (!capabilities || !rawUrl) return false;
  let target;
  try { target = new URL(rawUrl); } catch { return false; }
  return capabilities.hostPermissions.some((permission) => {
    if (permission === "<all_urls>") return ["http:", "https:"].includes(target.protocol);
    const match = String(permission).match(/^(\*|https?):\/\/(\*\.)?([^/]+)\//i);
    if (!match) return false;
    if (match[1] !== "*" && `${match[1].toLowerCase()}:` !== target.protocol) return false;
    const allowedHost = match[3].toLowerCase();
    const targetHost = target.hostname.toLowerCase();
    return match[2] ? targetHost === allowedHost || targetHost.endsWith(`.${allowedHost}`) : targetHost === allowedHost;
  });
}

function resolveContainedRealPath(baseDir, candidatePath) {
  const realBase = fs.realpathSync(baseDir);
  const realTarget = fs.realpathSync(candidatePath);
  const baseWithSep = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`;
  if (realTarget !== realBase && !realTarget.startsWith(baseWithSep)) return null;
  return realTarget;
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
  updateLocalServerStatus({ running: false, error: "" });

  localServer = http.createServer((req, res) => {
    void (async () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${localServerPort}`);
    const token = parsedUrl.searchParams.get("token") || req.headers["authorization"]?.split(" ")[1];

    const secureRoutes = ["/cookies", "/events", "/broadcast", "/state", "/tabs", "/active-tab", "/active-task", "/extension-debug-log"];
    if (secureRoutes.includes(parsedUrl.pathname)) {
      if (!tokenCanAccessRoute(token, parsedUrl.pathname)) {
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
      extensionDebugLog("local-server:active-tab", {
        hasUrl: Boolean(activeTabInfo.url),
        url: activeTabInfo.url || "",
        title: activeTabInfo.title || ""
      });
      sendJson(res, 200, activeTabInfo);
      return;
    }

    if (parsedUrl.pathname === "/cookies") {
      const filter = {};
      const url = String(parsedUrl.searchParams.get("url") || "").trim();
      const name = parsedUrl.searchParams.get("name");
      if (!/^https?:\/\//i.test(url)) {
        sendJson(res, 400, { error: "Cookie URL is required and must use http or https" });
        return;
      }
      try {
        const parsedCookieUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedCookieUrl.protocol) || !parsedCookieUrl.hostname) {
          sendJson(res, 400, { error: "Cookie URL is invalid" });
          return;
        }
      } catch {
        sendJson(res, 400, { error: "Cookie URL is invalid" });
        return;
      }
      filter.url = url;
      if (name) filter.name = name;
      const scopedCapabilities = token === sessionToken ? null : extensionAccessTokens.get(token);
      if (scopedCapabilities && !extensionCanAccessUrl(scopedCapabilities, url)) {
        sendJson(res, 403, { error: "Cookie host permission denied" });
        return;
      }
      const cookies = await workbenchSession().cookies.get(filter);
      extensionDebugLog("local-server:cookies", {
        url: filter.url || "",
        name: filter.name || "",
        count: cookies.length,
        cookieNames: cookies.map((cookie) => cookie.name)
      });
      sendJson(res, 200, cookies);
      return;
    }

    if (parsedUrl.pathname === "/extension-debug-log" && req.method === "POST") {
      try {
        const body = await getRequestBody(req);
        extensionDebugLog(
          String(body.event || "extension-background"),
          body.details && typeof body.details === "object" ? body.details : {}
        );
        sendJson(res, 200, { success: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
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

      const realTargetPath = resolveContainedRealPath(resolvedBase, targetPath);
      if (!realTargetPath) {
        sendJson(res, 403, { error: "Access denied" });
        return;
      }

      const stat = fs.statSync(realTargetPath);
      if (stat.isDirectory()) {
        const indexPath = path.join(realTargetPath, "index.html");
        if (fs.existsSync(indexPath)) {
          const realIndexPath = resolveContainedRealPath(resolvedBase, indexPath);
          if (realIndexPath) serveFile(res, realIndexPath);
          else sendJson(res, 403, { error: "Access denied" });
        } else {
          sendJson(res, 404, { error: "Index file not found in directory" });
        }
        return;
      }

      serveFile(res, realTargetPath);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
    })().catch((error) => {
      console.error("Local server request failed:", error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, error instanceof URIError ? 400 : 500, {
        error: error instanceof URIError ? "Malformed URL encoding" : "Internal server error"
      });
    });
  });

  localServer.on("error", (error) => {
    extensionDebugLog("local-server:error", { port: localServerPort, error: error?.message || String(error) });
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    updateLocalServerStatus({ running: false, error: error?.message || String(error) });
    localServer = null;
  });
  localServer.listen(localServerPort, "127.0.0.1", () => {
    extensionDebugLog("local-server:listening", { port: localServerPort });
    updateLocalServerStatus({ running: true, error: "" });
  });

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
  if (!localServer) {
    updateLocalServerStatus({ running: false });
    return;
  }
  localServer.close();
  localServer = null;
  updateLocalServerStatus({ running: false });
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
  const parsed = JSON.parse(fs.readFileSync(weeklyTasksPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Weekly tasks file must contain a JSON array");
  return parsed;
}

function writeWeeklyTasks(tasks) {
  if (!Array.isArray(tasks)) throw new Error("Weekly tasks payload must be an array");
  fs.mkdirSync(path.dirname(weeklyTasksPath), { recursive: true });
  if (fs.existsSync(weeklyTasksPath)) {
    const current = JSON.parse(fs.readFileSync(weeklyTasksPath, "utf8"));
    if (!Array.isArray(current)) throw new Error("Refusing to overwrite an invalid weekly tasks file");
    const backupPath = path.join(app.getPath("userData"), "backups", "weekly_tasks.json");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(weeklyTasksPath, backupPath);
  }
  const tempPath = `${weeklyTasksPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(tasks, null, 2), "utf8");
    fs.renameSync(tempPath, weeklyTasksPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
  return tasks;
}

function readWeeklyReports() {
  const filePath = weeklyReportsPath();
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Weekly reports file must contain a JSON array");
  return parsed;
}

function writeWeeklyReports(reports) {
  if (!Array.isArray(reports)) throw new Error("Weekly reports payload must be an array");
  const filePath = weeklyReportsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(current)) throw new Error("Refusing to overwrite an invalid weekly reports file");
    const backupPath = path.join(app.getPath("userData"), "backups", "weekly-reports.json");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(filePath, backupPath);
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(reports, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
  return reports;
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

function classifyDownload(filename, fromPipelineSource = false, expectedStep = "") {
  const lowerName = filename.toLowerCase();
  if (fromPipelineSource) {
    const chatArtifact = /^(dialogue|dialog|chat(?:[_ -]?log)?)(?:[_ -]?\d+)?\.(json|txt|md)$/i.test(lowerName);
    const reportArtifact = /^(eval(?:uation)?[_ -]?report|report)(?:[_ -]?\d+)?\.(pdf|html?)$/i.test(lowerName);
    if (["prepare", "testing"].includes(expectedStep) && chatArtifact) {
      return { type: "chat", folder: "chats" };
    }
    if (["evaluating", "report"].includes(expectedStep) && reportArtifact) {
      return { type: "report", folder: "reports" };
    }
  }
  return { type: "generic", folder: "downloads" };
}

// 工作台偏好：裁切方向 + 像素数，持久化到 userData/workbench-prefs.json
function workbenchPrefsPath() {
  return path.join(app.getPath("userData"), "workbench-prefs.json");
}

// platformFieldMap（V3.4 P1）：字段名 → CSS 选择器 的映射，用户可在偏好里编辑。
// 仅保留字符串键值对，过滤非法项，避免脏数据写入注入路径。
function normalizePlatformFieldMap(value) {
  const map = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [field, selector] of Object.entries(value)) {
      const key = String(field || "").trim();
      const sel = String(selector || "").trim();
      if (key && sel) map[key] = sel;
    }
  }
  return map;
}

function normalizeWeeklyReportDefaults(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    author: String(source.author || "").trim().slice(0, 80),
    titlePattern: String(source.titlePattern || "").trim().slice(0, 120)
  };
}

function normalizeWorkbenchPrefs(prefs = {}) {
  const side = ["bottom", "top", "right"].includes(prefs.cropSide) ? prefs.cropSide : "bottom";
  const pixels = Math.max(1, Math.min(2000, Math.round(Number(prefs.cropPixels) || 100)));
  const todoFilePath = typeof prefs.todoFilePath === "string" ? prefs.todoFilePath : "";
  const platformFieldMap = normalizePlatformFieldMap(prefs.platformFieldMap);
  const theme = ["sakura", "sky", "morning", "night"].includes(prefs.theme) ? prefs.theme : "sakura";
  const weeklyReportDefaults = normalizeWeeklyReportDefaults(prefs.weeklyReportDefaults);
  return { cropSide: side, cropPixels: pixels, todoFilePath, platformFieldMap, theme, weeklyReportDefaults };
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
    return normalizeWorkbenchPrefs();
  }
}

function resolveConfiguredPathCandidate(candidate) {
  const raw = String(candidate || "").trim();
  if (!raw || path.extname(raw).toLowerCase() !== ".txt") return "";
  try {
    const realPath = fs.realpathSync(raw);
    return fs.statSync(realPath).isFile() ? realPath : "";
  } catch {
    return "";
  }
}

function resolveConfiguredTodoFilePath() {
  const candidate = String(loadWorkbenchPrefs().todoFilePath || "").trim();
  if (!candidate) return { path: "", error: "not-configured" };
  if (path.extname(candidate).toLowerCase() !== ".txt") return { path: "", error: "invalid-file-type" };
  const resolved = resolveConfiguredPathCandidate(candidate);
  return resolved ? { path: resolved, error: "" } : { path: "", error: "not-found" };
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
  if (activeTaskFolder && path.resolve(activeTaskFolder) === target) {
    activeTaskFolder = "";
    activeTaskId = "";
    activeTaskStep = "idle";
    activeTaskSchool = "";
    activeTaskCourse = "";
    watchActiveTaskFolder();
    refreshUploadInterception();
    broadcastToSse("active-task-changed", { folderPath: "" });
  }
  if (!fs.existsSync(target)) return true;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    console.warn("Failed to clean task folder:", error);
    return false;
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
    // H1：FSWatcher 必须挂 error 监听——用户在资源管理器删除活动任务文件夹时
    // watcher 会发 error 事件，未捕获会冒泡成主进程 uncaughtException 崩溃。
    // 这里关闭失效 watcher 并清空活动任务，安全降级。
    taskFolderWatcher.on("error", (error) => {
      console.warn("任务文件夹监听异常，已停止监听:", error);
      try { taskFolderWatcher?.close(); } catch {}
      taskFolderWatcher = null;
      clearTimeout(taskFolderWatchTimer);
      if (activeTaskFolder && !fs.existsSync(activeTaskFolder)) {
        activeTaskFolder = "";
        activeTaskId = "";
        activeTaskStep = "idle";
        activeTaskSchool = "";
        activeTaskCourse = "";
        refreshUploadInterception();
        broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
      }
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
  while (fs.existsSync(path.join(dir, candidate)) || inFlightDownloadPaths.has(path.resolve(dir, candidate))) {
    candidate = `${base} (${counter})${extension}`;
    counter += 1;
  }
  return candidate;
}

function installDownloadHandler() {
  workbenchSession().on("will-download", (_event, item, webContents) => {
    const filename = safeDownloadName(item.getFilename());
    const hasActiveTask = Boolean(activeTaskFolder);
    const downloadTaskId = hasActiveTask ? activeTaskId : "";
    const downloadTaskStep = hasActiveTask ? activeTaskStep : "idle";
    let pageUrl = "";
    try {
      pageUrl = webContents?.getURL?.() || "";
    } catch {}
    const fromPipelineSource = isPipelineSourceUrl(item.getURL()) || isPipelineSourceUrl(pageUrl);
    const classification = hasActiveTask
      ? classifyDownload(filename, fromPipelineSource, downloadTaskStep)
      : { type: "generic", folder: "downloads" };
    const extension = path.extname(filename) || ".bin";
    let saveDir;
    let archiveName;
    if (hasActiveTask) {
      // 活动任务期间：所有下载汇入任务文件夹；eval_report/dialogue 特殊归档命名优先
      saveDir = activeTaskFolder;
      fs.mkdirSync(saveDir, { recursive: true });
      const preferredName = {
        chat: "dialogue.json",
        report: `eval_report${extension}`
      }[classification.type];
      archiveName = preferredName ? dedupeFileName(saveDir, preferredName) : dedupeFileName(saveDir, filename);
    } else {
      // 无活动任务：按普通浏览器行为保存到系统下载目录。
      saveDir = app.getPath("downloads");
      fs.mkdirSync(saveDir, { recursive: true });
      archiveName = dedupeFileName(saveDir, filename);
    }
    const savePath = path.join(saveDir, archiveName);
    inFlightDownloadPaths.add(path.resolve(savePath));
    item.setSavePath(savePath);

    const captured = hasActiveTask;
    const notifySchool = activeTaskSchool;
    const notifyCourse = activeTaskCourse;
    item.once("done", (_doneEvent, state) => {
      inFlightDownloadPaths.delete(path.resolve(savePath));
      sendToRenderer("download-completed", {
        state,
        type: classification.type,
        path: savePath,
        filename: path.basename(savePath),
        originalFilename: filename,
        captured,
        taskId: downloadTaskId,
        taskStep: downloadTaskStep
      });
      // 仅活动任务的评估报告：窗口未聚焦时发系统通知；权限失败静默
      if (
        state === "completed"
        && classification.type === "report"
        && captured
        && mainWindow
        && !mainWindow.isFocused()
      ) {
        try {
          if (Notification.isSupported()) {
            const body = [notifySchool, notifyCourse].filter(Boolean).join(" ").trim()
              || path.basename(savePath);
            new Notification({
              title: "评估报告已就绪",
              body
            }).show();
          }
        } catch {
          // 通知失败不阻塞下载归档与 renderer toast
        }
      }
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

function getExtensionCapabilities(manifest = {}) {
  const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
  const hostPermissions = [
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
    ...[...permissions].filter((permission) => /^(<all_urls>|\*|https?:\/\/)/.test(permission))
  ];
  const polymasHostAccess = hostPermissions.some((permission) =>
    permission === "<all_urls>" || /polymas\.com/i.test(permission)
  );
  const capabilities = {
    tabs: permissions.has("tabs") || permissions.has("activeTab"),
    cookies: permissions.has("cookies") && hostPermissions.length > 0,
    api: false,
    hostPermissions
  };
  capabilities.api = polymasHostAccess && extensionCanAccessUrl(capabilities, extensionApiBaseUrl);
  return capabilities;
}

function resolveExtensionRelativePath(rootPath, relativePath) {
  const value = String(relativePath || "");
  if (!value || path.isAbsolute(value)) return null;
  const root = path.resolve(rootPath);
  const target = path.resolve(root, value);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  if (fs.existsSync(root) && fs.existsSync(target)) {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(`${realRoot}${path.sep}`)) return null;
  }
  return target;
}

function extensionStoragePolyfillSource(token, capabilities = {}) {
  return `;(() => {
  const chromeApi = globalThis.chrome = globalThis.chrome || {};
  const workbenchApiBase = "http://127.0.0.1:${localServerPort}";
  const workbenchToken = ${JSON.stringify(token)};
  const workbenchFetchJson = async (path) => {
    const response = await fetch(\`\${workbenchApiBase}\${path}\`, {
      headers: { Authorization: \`Bearer \${workbenchToken}\` }
    });
    if (!response.ok) throw new Error(\`Workbench API \${path} failed: \${response.status}\`);
    return response.json();
  };
  const workbenchDebugLog = (event, details = {}) => {
    fetch(\`\${workbenchApiBase}/extension-debug-log\`, {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${workbenchToken}\`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event, details })
    }).catch(() => {});
  };
  const asChromeAsync = (executor) => (...args) => {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const promise = Promise.resolve().then(() => executor(...args));
    if (callback) {
      promise.then(
        (value) => callback(value),
        (error) => {
          chromeApi.runtime = chromeApi.runtime || {};
          chromeApi.runtime.lastError = { message: error?.message || String(error) };
          try { callback(); } finally { delete chromeApi.runtime.lastError; }
        }
      );
      return undefined;
    }
    return promise;
  };
  const listeners = new Set();
  const notify = (changes, areaName) => {
    for (const listener of listeners) {
      try { listener(changes, areaName); } catch {}
    }
  };
  const createArea = (areaName) => {
    const store = Object.create(null);
    return {
      get: asChromeAsync(async (keys) => {
        if (keys == null) return { ...store };
        if (typeof keys === "string") return { [keys]: store[keys] };
        if (Array.isArray(keys)) return keys.reduce((acc, key) => {
          acc[key] = store[key];
          return acc;
        }, {});
        if (typeof keys === "object") return Object.keys(keys).reduce((acc, key) => {
          acc[key] = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : keys[key];
          return acc;
        }, {});
        return {};
      }),
      set: asChromeAsync(async (items = {}) => {
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
        }
        notify(changes, areaName);
      }),
      remove: asChromeAsync(async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      }),
      clear: asChromeAsync(async () => {
        for (const key of Object.keys(store)) delete store[key];
      }),
      setAccessLevel: asChromeAsync(async () => {})
    };
  };
  chromeApi.storage = chromeApi.storage || {};
  chromeApi.storage.local = chromeApi.storage.local || createArea("local");
  chromeApi.storage.sync = chromeApi.storage.sync || createArea("sync");
  chromeApi.storage.session = chromeApi.storage.session || createArea("session");
  chromeApi.storage.onChanged = chromeApi.storage.onChanged || {
    addListener(listener) { if (typeof listener === "function") listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); }
  };
  if (${Boolean(capabilities.tabs)}) {
  chromeApi.tabs = chromeApi.tabs || {};
  chromeApi.tabs.query = asChromeAsync(async () => {
    const tab = await workbenchFetchJson("/active-tab");
    const result = tab && tab.url
      ? [{ id: 9999, url: tab.url, title: tab.title || "", active: true, currentWindow: true }]
      : [];
    workbenchDebugLog("background-polyfill:tabs-query", { hasUrl: Boolean(tab && tab.url), count: result.length });
    return result;
  });
  chromeApi.tabs.onUpdated = chromeApi.tabs.onUpdated || {
    addListener() {},
    removeListener() {},
    hasListener() { return false; }
  };
  }
  if (${Boolean(capabilities.cookies)}) {
  chromeApi.cookies = chromeApi.cookies || {};
  chromeApi.cookies.getAll = asChromeAsync(async (details = {}) => {
    const params = new URLSearchParams();
    if (details.url) params.set("url", details.url);
    if (details.name) params.set("name", details.name);
    const cookies = await workbenchFetchJson(\`/cookies?\${params.toString()}\`);
    workbenchDebugLog("background-polyfill:cookies-get-all", {
      url: details.url || "",
      name: details.name || "",
      count: Array.isArray(cookies) ? cookies.length : 0,
      cookieNames: Array.isArray(cookies) ? cookies.map((cookie) => cookie.name) : []
    });
    return cookies;
  });
  chromeApi.cookies.get = asChromeAsync(async (details = {}) => {
    const cookies = await chromeApi.cookies.getAll(details);
    return cookies[0] || null;
  });
  }
})();`;
}

function prepareExtensionForElectron(extensionPath, manifest = {}, token, capabilities) {
  const backgroundScript = manifest.background?.service_worker || manifest.background?.scripts?.[0];
  if (!backgroundScript) return extensionPath;
  const sourceBackgroundPath = resolveExtensionRelativePath(extensionPath, backgroundScript);
  if (!sourceBackgroundPath) throw new Error("Extension background script escapes its directory");
  if (!fs.existsSync(sourceBackgroundPath)) return extensionPath;

  const hash = crypto
    .createHash("sha1")
    .update(`${extensionPath}\0${fs.statSync(sourceBackgroundPath).mtimeMs}`)
    .digest("hex")
    .slice(0, 12);
  const targetRoot = path.join(app.getPath("userData"), "extension-compat", hash);
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.cpSync(extensionPath, targetRoot, { recursive: true });

  const targetBackgroundPath = resolveExtensionRelativePath(targetRoot, backgroundScript);
  if (!targetBackgroundPath) throw new Error("Extension background target escapes its directory");
  const backgroundSource = fs.readFileSync(targetBackgroundPath, "utf8");
  if (!backgroundSource.includes("workbench-electron-storage-polyfill")) {
    fs.writeFileSync(
      targetBackgroundPath,
      `/* workbench-electron-storage-polyfill */\n${extensionStoragePolyfillSource(token, capabilities)}\n${backgroundSource}`,
      "utf8"
    );
  }
  extensionDebugLog("extension:compat-prepared", { source: extensionPath, target: targetRoot, backgroundScript });
  return targetRoot;
}

async function loadConfiguredExtensions(entries = readExtensionConfig()) {
  const results = [];
  for (const entry of entries.filter((item) => item && item.enabled !== false)) {
    const extensionPath = resolveExtensionPath(entry);
    if (!extensionPath || !fs.existsSync(extensionPath)) {
      results.push({ ...entry, ok: false, message: "未找到扩展目录" });
      continue;
    }
    let accessToken = "";
    try {
      const manifestPath = path.join(extensionPath, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : {};
      const action = manifest.action || manifest.browser_action || {};
      const capabilities = getExtensionCapabilities(manifest);
      accessToken = crypto.randomBytes(24).toString("hex");
      extensionAccessTokens.set(accessToken, capabilities);
      const defaultIcon = typeof action.default_icon === "string"
        ? action.default_icon
        : action.default_icon?.["16"] || action.default_icon?.["32"] || manifest.icons?.["16"] || manifest.icons?.["32"] || "";
      const loadPath = prepareExtensionForElectron(extensionPath, manifest, accessToken, capabilities);

      const extension = await workbenchSession().extensions.loadExtension(loadPath, {
        allowFileAccess: true
      });
      extensionCapabilities.set(extension.id, capabilities);
      loadedExtensionTokens.set(extension.id, accessToken);
      results.push({
        ...entry,
        id: extension.id,
        ok: true,
        name: extension.name,
        version: extension.version,
        path: extensionPath,
        loadPath,
        popupPage: action.default_popup || manifest.side_panel?.default_path || manifest.options_page || manifest.options_ui?.page || "",
        defaultIcon,
        iconDataUrl: readExtensionIcon(extensionPath, defaultIcon),
        message: "已成功启用"
      });
    } catch (error) {
      if (accessToken) extensionAccessTokens.delete(accessToken);
      results.push({ ...entry, ok: false, path: extensionPath, message: error.message });
    }
  }
  return results;
}

async function unloadConfiguredExtensions() {
  for (const extension of workbenchSession().extensions.getAllExtensions()) {
    try {
      await workbenchSession().extensions.removeExtension(extension.id);
    } catch {}
    extensionCapabilities.delete(extension.id);
    const token = loadedExtensionTokens.get(extension.id);
    if (token) extensionAccessTokens.delete(token);
    loadedExtensionTokens.delete(extension.id);
  }
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

function extensionIdFromIpcEvent(event) {
  const senderUrl = String(event?.senderFrame?.url || event?.sender?.getURL?.() || "");
  const match = senderUrl.match(/^chrome-extension:\/\/([a-p]{32})(?:\/|$)/i);
  return match ? match[1] : "";
}

function requireExtensionCapability(event, capability) {
  const extensionId = extensionIdFromIpcEvent(event);
  if (!extensionId || !extensionCapabilities.get(extensionId)?.[capability]) {
    throw new Error(`Extension is not allowed to use ${capability}`);
  }
  return extensionId;
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
  ipcMain.handle("task:active-update", (_event, info = {}) => {
    // 活动任务文件夹必须位于 temp/tasks 下，非法路径一律视为无活动任务
    const validated = info.folderPath ? resolveTaskPath(info.folderPath) : null;
    let isValidDirectory = false;
    try {
      isValidDirectory = Boolean(validated && fs.statSync(validated).isDirectory());
    } catch {}
    activeTaskFolder = isValidDirectory ? validated : "";
    activeTaskId = activeTaskFolder ? String(info.taskId || "") : "";
    activeTaskStep = activeTaskFolder ? String(info.step || "testing") : "idle";
    activeTaskSchool = activeTaskFolder ? String(info.school || "") : "";
    activeTaskCourse = activeTaskFolder ? String(info.course || "") : "";
    watchActiveTaskFolder();
    refreshUploadInterception();
    broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
    return {
      success: true,
      folderPath: activeTaskFolder,
      taskId: activeTaskId,
      step: activeTaskStep
    };
  });
  ipcMain.on("tabs:list-update", (_event, list = []) => {
    allTabs = list;
    broadcastToSse("tab-list-changed", allTabs);
  });
  ipcMain.handle("local-server:status", () => ({ ...localServerStatus }));
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
      embeddedWindowRects.delete(tabId);
      embeddedWindowPendingRects.delete(tabId);
      runningDesktopApps.delete(tabId);
    }
    const localId = String(tabId || "");
    localAppsMap.delete(localId);
    const localToken = localAppTokensByTabId.get(localId);
    if (localToken) localAppAccessTokens.delete(localToken);
    localAppTokensByTabId.delete(localId);
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
    activeTaskId = String(task.id || "");
    activeTaskStep = "prepare";
    activeTaskSchool = String(task.school || "");
    activeTaskCourse = String(task.course || "");
    watchActiveTaskFolder();
    refreshUploadInterception();
    broadcastToSse("active-task-changed", { folderPath: activeTaskFolder });
    return folderPath;
  });
  ipcMain.handle("tasks:activate-folder", (_event, task = {}) => {
    const validated = task.folderPath ? resolveTaskPath(task.folderPath) : null;
    if (!validated || !fs.existsSync(validated) || !fs.statSync(validated).isDirectory()) {
      return { success: false, error: "Task folder is missing or invalid" };
    }
    return { success: true, folderPath: validated };
  });
  // 上传拦截浮层结果回传：paths 为空 = 用户取消（不注入，等同原生取消）
  ipcMain.handle("upload:resolve-files", async (_event, requestId, paths) => {
    const request = pendingUploadRequests.get(Number(requestId));
    if (!request) return { ok: false, error: "请求不存在或已处理" };
    pendingUploadRequests.delete(Number(requestId));
    if (request.contents.isDestroyed()) return { ok: false, error: "页面已关闭" };
    try {
      const validated = validateUploadPaths(paths, request.taskFolder);
      if (!validated.ok) return validated;
      return await injectUploadFiles(request.contents, request.backendNodeId, validated.paths);
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
  ipcMain.handle("tasks:open-folder", async (_event, folderPath) => {
    const target = resolveTaskPath(folderPath);
    if (!target || !fs.existsSync(target)) return false;
    return (await shell.openPath(target)) === "";
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
    if (result.canceled) return [];
    rememberApprovedUploadPaths(result.filePaths);
    return result.filePaths;
  });
  // 工作台偏好：读取 / 保存（持久化到 userData）
  ipcMain.handle("prefs:get-workbench", () => loadWorkbenchPrefs());
  ipcMain.handle("prefs:set-workbench", (_event, prefs) => {
    // todoFilePath 只由主进程文件选择器写入，renderer 传入的同名字段一律忽略。
    const current = loadWorkbenchPrefs();
    const next = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? { ...prefs } : {};
    delete next.todoFilePath;
    return saveWorkbenchPrefs({ ...current, ...next, todoFilePath: current.todoFilePath });
  });
  // 选择待做任务.txt：系统对话框定位后写入偏好，之后一键直读
  ipcMain.handle("dialog:pick-todo-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "文本文件", extensions: ["txt"] }]
    });
    if (result.canceled || !result.filePaths.length) return "";
    const picked = String(result.filePaths[0] || "");
    const resolved = path.extname(picked).toLowerCase() === ".txt" ? resolveConfiguredPathCandidate(picked) : "";
    if (!resolved) return "";
    saveWorkbenchPrefs({ ...loadWorkbenchPrefs(), todoFilePath: resolved });
    return resolved;
  });
  // 读取待做任务.txt：只允许读偏好中登记的这一个路径；UTF-8 + BOM 兼容；
  // 出现替换字符（U+FFFD）视为非 UTF-8 编码，提示用户转存，不做 GBK 转码（范围外）
  ipcMain.handle("tasks:read-todo-file", () => {
    const resolved = resolveConfiguredTodoFilePath();
    const todoPath = resolved.path;
    if (!todoPath) return { ok: false, error: resolved.error };
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
  // 平台单字段试注入（V3.4 P1 预研）：对目标 webview 按 CSS 选择器注入一个字段值，
  // 验证 CDP/JS 注入路径可行。同时支持 input/textarea（value）与 contenteditable 富文本编辑器。
  // 仅试注入，不点击提交按钮（提交动作永远由用户人工确认）。
  ipcMain.handle("platform:test-inject", async (_event, payload = {}) => {
    const webContentsId = Number(payload.webContentsId);
    const selector = String(payload.selector || "").trim();
    const value = String(payload.value ?? "");
    if (!webContentsId || !selector) return { ok: false, error: "缺少目标页面或选择器" };
    const target = [...webviewContentsSet].find(
      (contents) => !contents.isDestroyed() && contents.id === webContentsId
    );
    if (!target) return { ok: false, error: "目标 webview 不存在或已销毁" };
    try {
      const result = await target.executeJavaScript(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: "未找到匹配选择器的元素" };
          const text = ${JSON.stringify(value)};
          el.focus();
          if (el.isContentEditable) {
            el.textContent = text;
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
            return { ok: true, kind: "contenteditable" };
          }
          if ("value" in el) {
            const setter = Object.getOwnPropertyDescriptor(el.__proto__, "value")?.set;
            if (setter) setter.call(el, text); else el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, kind: el.tagName.toLowerCase() };
          }
          return { ok: false, error: "目标元素既非输入框也非可编辑区" };
        })();
      `, true);
      return result || { ok: false, error: "注入脚本无返回" };
    } catch (error) {
      return { ok: false, error: `注入失败: ${error.message}` };
    }
  });
  // 读取任务文件夹内文本文件（卡片舱 cards.md 用）：限制在 temp/tasks 内 + 2MB 上限
  ipcMain.handle("tasks:read-text-file", (_event, filePath) => {
    const target = resolveTaskPath(filePath);
    if (!target || !fs.existsSync(target)) return { ok: false, error: "文件不存在或越出任务目录" };
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return { ok: false, error: "目标不是文件" };
      if (stat.size > 2 * 1024 * 1024) return { ok: false, error: "文件超过 2MB，疑似非文本产物" };
      let text = fs.readFileSync(target, "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return { ok: true, text, mtime: stat.mtimeMs };
    } catch (error) {
      return { ok: false, error: `读取失败: ${error.message}` };
    }
  });
  // 写回待做任务.txt：只允许写偏好中登记的那一个 txt 路径 + 同目录 .bak（每次覆盖，保留最近一次）；
  // renderer 负责生成完整新文本（BOM/换行风格已在纯函数中保持），这里不做内容加工
  ipcMain.handle("tasks:write-todo-file", (_event, newText) => {
    const resolved = resolveConfiguredTodoFilePath();
    const todoPath = resolved.path;
    if (!todoPath) return { ok: false, error: resolved.error };
    if (typeof newText !== "string" || !newText.trim()) return { ok: false, error: "写回内容为空，已取消" };
    const backupPath = `${todoPath}.bak`;
    try {
      fs.copyFileSync(todoPath, backupPath);
    } catch (error) {
      return { ok: false, error: `备份失败，已取消写回: ${error.message}`, path: todoPath };
    }
    try {
      fs.writeFileSync(todoPath, newText, "utf8");
    } catch (error) {
      return { ok: false, error: `写入失败: ${error.message}`, path: todoPath };
    }
    return { ok: true, path: todoPath, backupPath };
  });
  // 图片裁切去水印：nativeImage 实现；裁切结果覆盖原文件（先写临时文件再 rename）
  // webp 源只能输出 png：覆盖为同主文件名 .png，并删除原 .webp
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
    const dir = path.dirname(target);
    const base = path.basename(target, extension);
    // nativeImage 无法编码 webp，webp 源输出为 png 并替换原文件
    const outExtension = /\.jpe?g$/i.test(extension) ? extension : /\.webp$/i.test(extension) ? ".png" : extension;
    const finalPath = path.join(dir, `${base}${outExtension}`);
    const finalResolved = resolveTaskPath(finalPath);
    if (!finalResolved) return { ok: false, error: "输出路径越出任务目录" };
    const tempPath = path.join(dir, `.${base}.crop-tmp-${Date.now()}${outExtension}`);
    const tempResolved = resolveTaskPath(tempPath);
    if (!tempResolved) return { ok: false, error: "临时路径越出任务目录" };
    const buffer = /\.jpe?g$/i.test(outExtension) ? cropped.toJPEG(90) : cropped.toPNG();
    try {
      fs.writeFileSync(tempResolved, buffer);
      fs.renameSync(tempResolved, finalResolved);
      if (/\.webp$/i.test(extension) && path.resolve(target) !== path.resolve(finalResolved) && fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
      }
    } catch (error) {
      try { if (fs.existsSync(tempResolved)) fs.rmSync(tempResolved, { force: true }); } catch {}
      return { ok: false, error: `写入失败: ${error.message}` };
    }
    return { ok: true, path: finalResolved };
  });
  // 托盘文件操作：打开 / 资源管理器定位 / 重命名 / 删除，全部限制在 temp/tasks 内
  ipcMain.handle("tasks:file-action", async (_event, payload = {}) => {
    const target = resolveTaskPath(payload.filePath);
    if (!target || target === path.resolve(downloadRoot, "tasks") || !fs.existsSync(target)) {
      return { ok: false, error: "文件不存在或越出任务目录" };
    }
    const action = String(payload.action || "");
    if (action === "open") {
      const err = await shell.openPath(target);
      return err ? { ok: false, error: err } : { ok: true, path: target };
    }
    if (action === "reveal") {
      shell.showItemInFolder(target);
      return { ok: true, path: target };
    }
    if (action === "delete") {
      fs.rmSync(target, { recursive: true, force: true });
      return { ok: true };
    }
    if (action === "rename") {
      const rawName = String(payload.newName || "").trim();
      if (!rawName) return { ok: false, error: "新文件名不能为空" };
      if (rawName === "." || rawName === ".." || /[\\/:*?"<>|]/.test(rawName)) {
        return { ok: false, error: "文件名含非法字符" };
      }
      if (rawName.includes("\0")) return { ok: false, error: "文件名非法" };
      const dest = path.join(path.dirname(target), rawName);
      const destResolved = resolveTaskPath(dest);
      if (!destResolved) return { ok: false, error: "目标路径越出任务目录" };
      if (path.resolve(destResolved) === path.resolve(target)) {
        return { ok: true, path: target, name: path.basename(target) };
      }
      // 禁止改到其他任务文件夹：必须仍在原父目录下
      if (path.resolve(path.dirname(destResolved)) !== path.resolve(path.dirname(target))) {
        return { ok: false, error: "只能在同一任务文件夹内重命名" };
      }
      if (fs.existsSync(destResolved)) return { ok: false, error: "同目录已存在同名文件" };
      try {
        fs.renameSync(target, destResolved);
      } catch (error) {
        return { ok: false, error: `重命名失败: ${error.message}` };
      }
      return { ok: true, previousPath: target, path: destResolved, name: path.basename(destResolved) };
    }
    return { ok: false, error: "未知操作" };
  });
  ipcMain.handle("workbench:get-active-tab-info", (event) => {
    requireExtensionCapability(event, "tabs");
    return activeTabInfo;
  });
  ipcMain.handle("workbench:get-cookies", async (event, details = {}) => {
    const extensionId = requireExtensionCapability(event, "cookies");
    if (!extensionCanAccessUrl(extensionCapabilities.get(extensionId), details.url)) return [];
    return getWorkbenchCookies(details);
  });
  ipcMain.on("workbench:extension-debug-log", (event, payload = {}) => {
    if (!extensionIdFromIpcEvent(event)) return;
    const { event: logEvent = "preload", details = {} } = payload && typeof payload === "object" ? payload : {};
    extensionDebugLog(String(logEvent), details && typeof details === "object" ? details : {});
  });
  ipcMain.handle("workbench:extension-api-request", async (event, payload = {}) => {
    requireExtensionCapability(event, "api");
    return requestExtensionApi(payload);
  });
  ipcMain.handle("tasks:read-weekly", () => readWeeklyTasks());
  ipcMain.handle("tasks:write-weekly", (_event, tasks) => writeWeeklyTasks(tasks));

  ipcMain.handle("tokenbox:status", () => tokenboxBridgeStatus());
  ipcMain.handle("tokenbox:backup", async () => callTokenboxBridge("backup_database", {}));
  ipcMain.handle("tokenbox:rebuild", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const provider = normalizeTokenboxProvider(body.provider);
      return await callTokenboxBridge("rebuild_usage_ledger", {
        ...(provider && provider !== "all" ? { provider } : {})
      });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:refresh", async (_event, payload = {}) => {
    try {
      const filter = normalizeTokenboxFilter(payload && typeof payload === "object" ? payload.filter : {});
      const result = await requestTokenboxBridge("refresh_dashboard", { filter });
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:evidence", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const filter = normalizeTokenboxFilter(body.filter || {});
      const model = normalizeTokenboxModel(body.model);
      const provider = normalizeTokenboxProvider(body.provider);
      return await callTokenboxBridge("get_evidence", {
        filter,
        model,
        ...(provider && provider !== "all" ? { provider } : {})
      });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:export-dashboard", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const filter = normalizeTokenboxFilter(body.filter || {});
      const format = normalizeTokenboxFormat(body.format, ["json", "csv"]);
      return await callTokenboxBridge("export_dashboard", { filter, format });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:audit", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const filter = normalizeTokenboxFilter(body.filter || {});
      return await callTokenboxBridge("get_audit_summary", { filter });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:export-audit", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const filter = normalizeTokenboxFilter(body.filter || {});
      const format = normalizeTokenboxFormat(body.format, ["json", "md"]);
      return await callTokenboxBridge("export_audit_report", { filter, format });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:relay-import", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      if (typeof body.content !== "string" || !body.content.trim()) {
        throw new Error("TokenBox relay content is required");
      }
      if (Buffer.byteLength(body.content, "utf8") > 50 * 1024 * 1024) {
        throw new Error("TokenBox relay file exceeds 50 MB");
      }
      const format = body.format ? normalizeTokenboxFormat(body.format, ["auto", "json", "csv"]) : "auto";
      const sourceName = normalizeTokenboxSourceName(body.sourceName);
      return await callTokenboxBridge("import_relay", {
        content: body.content,
        format,
        source_name: sourceName
      });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:reconciliation", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const filter = normalizeTokenboxFilter(body.filter || {});
      return await callTokenboxBridge("get_reconciliation", { filter });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("tokenbox:export-reconciliation", async (_event, payload = {}) => {
    try {
      const body = payload && typeof payload === "object" ? payload : {};
      const filter = normalizeTokenboxFilter(body.filter || {});
      const format = normalizeTokenboxFormat(body.format, ["json", "csv"]);
      return await callTokenboxBridge("export_reconciliation", { filter, format });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle("homework-variance:status", () => homeworkVarianceStatus());
  ipcMain.handle("homework-variance:start", () => startHomeworkVariance());
  ipcMain.handle("homework-variance:stop", () => {
    stopHomeworkVariance();
    return { success: true };
  });

  ipcMain.handle("reports:read-weekly", () => readWeeklyReports());
  ipcMain.handle("reports:write-weekly", (_event, reports) => writeWeeklyReports(reports));
  ipcMain.handle("reports:copy-weekly", (_event, payload = {}) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    const html = typeof payload.html === "string" ? payload.html : "";
    if (!text && !html) return { success: false, error: "Weekly report content is empty" };
    clipboard.write({ text, html });
    return { success: true };
  });
  ipcMain.handle("reports:export-weekly", async (_event, payload = {}) => {
    const format = payload.format === "docx"
      ? "docx"
      : payload.format === "markdown"
        ? "markdown"
        : "html";
    const suggestedName = safePathPart(payload.filename || "weekly-report") || "weekly-report";
    if (format === "docx") {
      try {
        const { buildWeeklyReportDocx } = require("./weekly-report-docx");
        const buffer = await buildWeeklyReportDocx(payload.report || {});
        const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
          defaultPath: path.join(app.getPath("documents"), `${suggestedName}.docx`),
          filters: [{ name: "Word Document", extensions: ["docx"] }]
        });
        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        fs.writeFileSync(result.filePath, buffer);
        return { success: true, path: result.filePath };
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    }
    const content = typeof payload.content === "string" ? payload.content : "";
    if (!content) return { success: false, error: "Weekly report content is empty" };
    const extension = format === "markdown" ? "md" : "html";
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      defaultPath: path.join(app.getPath("documents"), `${suggestedName}.${extension}`),
      filters: format === "markdown"
        ? [{ name: "Markdown", extensions: ["md"] }]
        : [{ name: "HTML", extensions: ["html"] }]
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    fs.writeFileSync(result.filePath, content, "utf8");
    return { success: true, path: result.filePath };
  });


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
    await unloadConfiguredExtensions();
    extensionResults = await loadConfiguredExtensions(safeEntries);
    return extensionResults;
  });
  ipcMain.handle("extensions:refresh", async () => {
    await unloadConfiguredExtensions();
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
      properties: ["openFile"],
      filters: [{ name: "Desktop applications", extensions: ["exe", "com", "bat", "cmd"] }]
    });
    if (result.canceled) return null;
    return approveDesktopAppPath(result.filePaths[0]) || null;
  });

  ipcMain.handle("local-apps:register", (_event, tabId, baseDir) => {
    if (!tabId || !baseDir) return false;
    try {
      const realBaseDir = fs.realpathSync(String(baseDir));
      if (!fs.statSync(realBaseDir).isDirectory()) return false;
      localAppsMap.set(String(tabId), realBaseDir);
      const id = String(tabId);
      const previousToken = localAppTokensByTabId.get(id);
      if (previousToken) localAppAccessTokens.delete(previousToken);
      const token = crypto.randomBytes(24).toString("hex");
      localAppTokensByTabId.set(id, token);
      localAppAccessTokens.set(token, { tabId: id, routes: LOCAL_APP_ALLOWED_ROUTES });
    } catch {
      return false;
    }
    return true;
  });

  ipcMain.handle("local-apps:get-token", (_event, tabId) => {
    const token = localAppTokensByTabId.get(String(tabId || ""));
    return token && localAppAccessTokens.has(token) ? token : "";
  });

  ipcMain.handle("desktop-app:launch", async (_event, tabId, exePath, cwd, embedMode, rect) => {
    const approvedExePath = isApprovedDesktopAppPath(exePath);
    if (!approvedExePath) {
      return { success: false, error: "桌面程序必须先通过工作台文件选择器或拖入登记" };
    }
    let approvedCwd = path.dirname(approvedExePath);
    if (cwd) {
      try {
        const realCwd = fs.realpathSync(String(cwd));
        if (fs.statSync(realCwd).isDirectory()) approvedCwd = realCwd;
      } catch {}
    }
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
          bindWindow(tabId, existing.pid, approvedExePath, parentHwnd, rect);
        }
        
        return { success: true, pid: existing.pid };
      } catch (e) {
        embeddedWindows.delete(tabId);
        embeddedWindowRects.delete(tabId);
        embeddedWindowPendingRects.delete(tabId);
        runningDesktopApps.delete(tabId);
      }
    }

    try {
      const options = {};
      options.cwd = approvedCwd;

      const child = spawn(approvedExePath, [], {
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
        if (runningDesktopApps.get(tabId) !== appInfo) return;
        // 如果窗口已成功绑定，则包装/启动器进程的退出属于正常现象，不清理状态
        if (embeddedWindows.has(tabId)) {
          return;
        }
        embeddedWindows.delete(tabId);
        embeddedWindowRects.delete(tabId);
        embeddedWindowPendingRects.delete(tabId);
        runningDesktopApps.delete(tabId);
        sendToRenderer(`desktop-app:status-change:${tabId}`, { running: false, pid: null });
      });

      child.on("error", (err) => {
        if (runningDesktopApps.get(tabId) !== appInfo) return;
        if (embeddedWindows.has(tabId)) {
          return;
        }
        embeddedWindows.delete(tabId);
        embeddedWindowRects.delete(tabId);
        embeddedWindowPendingRects.delete(tabId);
        runningDesktopApps.delete(tabId);
        sendToRenderer(`desktop-app:status-change:${tabId}`, { running: false, pid: null, error: err.message });
      });

      if (embedMode && rect) {
        const buffer = mainWindow.getNativeWindowHandle();
        const parentHwnd = buffer.length === 8 
          ? buffer.readBigInt64LE(0).toString() 
          : buffer.readInt32LE(0).toString();
        bindWindow(tabId, child.pid, approvedExePath, parentHwnd, rect);
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
      embeddedWindowRects.delete(tabId);
      embeddedWindowPendingRects.delete(tabId);
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
    embeddedWindowRects.delete(tabId);
    embeddedWindowPendingRects.delete(tabId);
    runningDesktopApps.delete(tabId);
    return { success: true };
  });

  ipcMain.handle("desktop-app:resize-window", (_event, tabId, rect) => {
    const childHwnd = embeddedWindows.get(tabId);
    if (childHwnd && rect) {
      const normalizedRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
      const rectKey = JSON.stringify(normalizedRect);
      if (embeddedWindowRects.get(tabId) === rectKey || embeddedWindowPendingRects.get(tabId) === rectKey) return true;
      embeddedWindowPendingRects.set(tabId, rectKey);
      const binder = runWindowBinder([
        "-Action", "resize",
        "-ChildHWnd", childHwnd,
        "-X", String(normalizedRect.x),
        "-Y", String(normalizedRect.y),
        "-Width", String(normalizedRect.width),
        "-Height", String(normalizedRect.height)
      ]);
      binder.once("error", () => {
        if (embeddedWindowPendingRects.get(tabId) === rectKey) embeddedWindowPendingRects.delete(tabId);
      });
      binder.once("close", (code) => {
        if (embeddedWindowPendingRects.get(tabId) === rectKey) embeddedWindowPendingRects.delete(tabId);
        if (code === 0) embeddedWindowRects.set(tabId, rectKey);
        else embeddedWindowRects.delete(tabId);
      });
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
      if (tabPtyProcesses.get(tabId) !== ptyProcess) return;
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
  loadDesktopAppAllowlist();
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
        let protocol = "";
        try { protocol = new URL(url).protocol; } catch {}
        if (["http:", "https:"].includes(protocol)) {
          contents.loadURL(url).catch(() => {});
        } else if (protocol === "mailto:") {
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

app.on("before-quit", () => {
  stopHomeworkVariance();
});

app.on("window-all-closed", () => {
  closeTokenboxBridge();
  stopTerminal();
  stopHomeworkVariance();
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
