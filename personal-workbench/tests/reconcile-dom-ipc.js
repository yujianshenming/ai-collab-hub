// 机器对账脚本（测试工程师 · V3.4 回归）
// 用途：回归清单 §0.1 静态检查的自动化实现
//   1. DOM 对账：renderer.js 里 elements 映射 + 所有 querySelector("#id") 引用的 id，逐一在 index.html 中存在
//   2. IPC 三端对账：main.js 的 ipcMain.handle/on 通道 ↔ preload*.js 的 ipcRenderer.invoke/send/on
// 只读分析，不启动应用。退出码非 0 表示发现不一致。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const rendererSrc = read("renderer.js");
const indexSrc = read("index.html");
const mainSrc = read("main.js");
const preloadSrc = read("preload.js");
const preloadPopupSrc = read("preload-popup.js");

let problems = [];
let info = [];

// ========== 1. DOM 对账 ==========
// 收集 index.html 中所有 id（含静态 + 模板字符串里出现的 id="..."）
const htmlIds = new Set();
for (const m of indexSrc.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);
// renderer.js 动态 innerHTML 模板里也会声明 id（如任务卡片），一并收集（id="..." 与 id='...'）
for (const m of rendererSrc.matchAll(/\bid=["'`]([^"'`$]+)["'`]/g)) htmlIds.add(m[1]);

// 收集 renderer.js 中所有 querySelector("#id") / getElementById("id") 静态字面量引用
const referencedIds = new Map(); // id -> 出现次数
function addRef(id) {
  // 跳过含模板变量/动态拼接的（带 ${ 或 + 的不是静态字面量）
  if (!id || id.includes("$") || id.includes("{")) return;
  referencedIds.set(id, (referencedIds.get(id) || 0) + 1);
}
for (const m of rendererSrc.matchAll(/querySelector\(\s*["'`]#([A-Za-z0-9_-]+)["'`]\s*\)/g)) addRef(m[1]);
for (const m of rendererSrc.matchAll(/getElementById\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*\)/g)) addRef(m[1]);

const missingDomIds = [];
for (const id of referencedIds.keys()) {
  if (!htmlIds.has(id)) missingDomIds.push(id);
}
if (missingDomIds.length) {
  problems.push(`[DOM] renderer 引用但 index.html/模板中不存在的 id（${missingDomIds.length}）: ${missingDomIds.join(", ")}`);
} else {
  info.push(`[DOM] 静态 #id 引用对账通过：renderer 引用 ${referencedIds.size} 个 id，全部在 HTML/模板中存在。`);
}

// 重点核查回归清单点名的几个 id（rightSidebarBody 前科、卡片舱新增）
const criticalIds = [
  "right-sidebar-body", "task-center-view", "nav-task-center", "sb-terminal",
  "rail-cards", "rail-cards-stream", "rail-cards-reparse"
];
const criticalMissing = criticalIds.filter((id) => !htmlIds.has(id));
if (criticalMissing.length) {
  problems.push(`[DOM] 关键 id 在 HTML/模板中缺失: ${criticalMissing.join(", ")}`);
} else {
  info.push(`[DOM] 关键 id 全部存在: ${criticalIds.join(", ")}`);
}

// ========== 2. IPC 三端对账 ==========
// main：ipcMain.handle/on 注册的通道
const mainChannels = new Set();
for (const m of mainSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*["'`]([^"'`]+)["'`]/g)) mainChannels.add(m[1]);

// main 主动发往渲染端的通道（webContents.send / mainWindow.webContents.send / event.sender.send 等）
const mainSendChannels = new Set();
for (const m of mainSrc.matchAll(/\.send\(\s*["'`]([^"'`$]+)["'`]/g)) mainSendChannels.add(m[1]);
// 动态频道（带模板变量，如 desktop-app:embedded-bound:${tabId}）单独收集前缀
const mainDynamicSendPrefixes = new Set();
for (const m of mainSrc.matchAll(/\.send\(\s*[`]([^`]*\$\{[^`]*)[`]/g)) {
  const prefix = m[1].split("${")[0];
  if (prefix) mainDynamicSendPrefixes.add(prefix);
}

// preload：ipcRenderer.invoke/send 调用的通道（renderer 侧请求 main）
const preloadInvokeSend = new Set();
const collectInvokeSend = (src) => {
  for (const m of src.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*["'`]([^"'`$]+)["'`]/g)) preloadInvokeSend.add(m[1]);
};
collectInvokeSend(preloadSrc);
collectInvokeSend(preloadPopupSrc);

// preload：ipcRenderer.on 监听的通道（接收 main 主动推送）
const preloadOnChannels = new Set();
const preloadOnDynamicPrefixes = new Set();
const collectOn = (src) => {
  for (const m of src.matchAll(/ipcRenderer\.on\(\s*["'`]([^"'`$]+)["'`]/g)) preloadOnChannels.add(m[1]);
  // 动态频道：const channel = `desktop-app:status-change:${tabId}`; ipcRenderer.on(channel, ...)
  for (const m of src.matchAll(/[`]([a-zA-Z0-9_:-]*?):\$\{[^`]*[`]/g)) {
    preloadOnDynamicPrefixes.add(m[1] + ":");
  }
};
collectOn(preloadSrc);
collectOn(preloadPopupSrc);

// 2a. preload invoke/send 的每个通道，main 必须有 handle/on
const invokeNoHandler = [];
for (const ch of preloadInvokeSend) {
  if (!mainChannels.has(ch)) invokeNoHandler.push(ch);
}
if (invokeNoHandler.length) {
  problems.push(`[IPC] preload invoke/send 调用但 main 无 handle/on 的通道（${invokeNoHandler.length}）: ${invokeNoHandler.join(", ")}`);
} else {
  info.push(`[IPC] preload→main 通道全部有 main 端处理（${preloadInvokeSend.size} 个 invoke/send）。`);
}

// 2b. main handle/on 的通道，应有 preload 调用（否则可能是死通道，仅告警不算硬错误）
const handlerNoCaller = [];
for (const ch of mainChannels) {
  if (!preloadInvokeSend.has(ch)) handlerNoCaller.push(ch);
}
if (handlerNoCaller.length) {
  info.push(`[IPC][告警] main 注册但 preload 未直接调用的通道（可能由 popup/动态或外部触发）: ${handlerNoCaller.join(", ")}`);
}

// 2c. preload ipcRenderer.on 监听的静态通道，main 应有对应 send（动态频道按前缀匹配）
const onNoSender = [];
for (const ch of preloadOnChannels) {
  if (mainSendChannels.has(ch)) continue;
  // 动态前缀匹配
  let matched = false;
  for (const p of mainDynamicSendPrefixes) {
    if (ch.startsWith(p)) { matched = true; break; }
  }
  if (!matched) onNoSender.push(ch);
}
if (onNoSender.length) {
  info.push(`[IPC][告警] preload on 监听但 main 未发现 send 的通道（可能是动态频道）: ${onNoSender.join(", ")}`);
} else {
  info.push(`[IPC] preload on 监听的静态通道均有 main send 对应。`);
}

// 2d. 回归清单点名的 popup 专用通道不得删除
const popupRequired = ["workbench:get-active-tab-info", "workbench:get-cookies", "workbench:get-session-token"];
const popupMissing = popupRequired.filter((ch) => !mainChannels.has(ch));
if (popupMissing.length) {
  problems.push(`[IPC] popup 必需通道在 main 缺失: ${popupMissing.join(", ")}`);
} else {
  info.push(`[IPC] popup 必需通道齐全: ${popupRequired.join(", ")}`);
}
// preload-popup 真实用到这些通道
const popupUsed = popupRequired.filter((ch) => preloadPopupSrc.includes(ch));
info.push(`[IPC] preload-popup 引用 popup 通道: ${popupUsed.join(", ")}`);

// ========== 输出 ==========
console.log("===== 机器对账结果 (DOM + IPC 三端) =====\n");
console.log(`HTML/模板 id 总数: ${htmlIds.size}`);
console.log(`renderer 静态 #id 引用数: ${referencedIds.size}`);
console.log(`main IPC 通道数(handle/on): ${mainChannels.size}`);
console.log(`preload invoke/send 通道数: ${preloadInvokeSend.size}`);
console.log(`preload on 监听静态通道数: ${preloadOnChannels.size}\n`);

console.log("--- 信息 ---");
for (const i of info) console.log("  " + i);

if (problems.length) {
  console.log("\n--- 问题（硬错误） ---");
  for (const p of problems) console.log("  ✗ " + p);
  console.log(`\n结果: 失败，发现 ${problems.length} 处不一致。`);
  process.exit(1);
} else {
  console.log("\n结果: 通过，未发现硬性不一致。");
  process.exit(0);
}
