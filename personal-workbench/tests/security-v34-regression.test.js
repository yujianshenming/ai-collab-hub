// V3.4 安全四项 + 三个修复回归（测试工程师）—— 回归清单 §6 + 附表 V3.4 三修复
// 纯静态/逻辑层校验，不启动应用：
//   安全四项：composedPath 外点关闭、token 注入白名单、静态服务路径穿越、temp/tasks 防穿越 + HTTP 鉴权
//   V3.4 三修复：分类折叠尾部重激活不自动展开、测试残留标签过滤、托盘悬停抖动 CSS 修复
// 跑法：node --test tests/security-v34-regression.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const rendererSrc = fs.readFileSync(path.join(ROOT, "renderer.js"), "utf8");
const styleSrc = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");

// ============ 安全①：temp/tasks 防穿越（resolveTaskPath 逻辑复刻） ============
// 复刻 main.js resolveTaskPath 的判定，固定 tasksRoot 后跑攻击向量，验证拒绝/放行口径
function makeResolveTaskPath(tasksRoot) {
  return (candidate) => {
    const target = path.resolve(String(candidate || ""));
    if (target !== tasksRoot && !target.startsWith(`${tasksRoot}${path.sep}`)) return null;
    return target;
  };
}

test("安全① temp/tasks 防穿越：合法子路径放行，越界路径拒绝", () => {
  const tasksRoot = path.resolve("C:/wb/temp/tasks");
  const resolve = makeResolveTaskPath(tasksRoot);

  // 合法：根本身、子文件夹、子文件
  assert.equal(resolve(tasksRoot), tasksRoot);
  assert.equal(resolve(path.join(tasksRoot, "t1_school")), path.join(tasksRoot, "t1_school"));
  assert.equal(resolve(path.join(tasksRoot, "t1", "dialogue.json")), path.join(tasksRoot, "t1", "dialogue.json"));

  // 越界：系统目录、.. 穿越、同名前缀目录（tasks-secret）
  assert.equal(resolve("C:/Windows"), null);
  assert.equal(resolve("C:/Windows/System32/cmd.exe"), null);
  assert.equal(resolve(path.join(tasksRoot, "..", "..", "secret.txt")), null);
  assert.equal(resolve("C:/wb/temp/tasks-secret/x"), null, "同名前缀目录必须拒绝（依赖 path.sep 边界）");
  assert.equal(resolve("C:/wb/temp/tasksX"), null);
});

test("安全① resolveTaskPath 与 cleanupTaskFolder 在 main.js 中真实存在且根目录不可清理", () => {
  assert.match(mainSrc, /function resolveTaskPath\(candidate\)/);
  // 所有任务文件 IPC 都经过 resolveTaskPath
  for (const ch of ["tasks:open-folder", "tasks:list-folder", "tasks:list-files", "tasks:file-action", "tasks:crop-image", "tasks:cleanup-folder"]) {
    assert.ok(mainSrc.includes(ch), `缺少通道 ${ch}`);
  }
  // cleanupTaskFolder 拒绝删除 tasks 根
  assert.match(mainSrc, /if \(!target \|\| target === path\.resolve\(downloadRoot, "tasks"\)\) return false/);
});

// ============ 安全②：静态服务路径穿越（local-apps base 边界复刻） ============
function makeStaticGuard(baseDir) {
  return (relPath) => {
    const resolvedBase = path.resolve(baseDir);
    const targetPath = path.resolve(resolvedBase, relPath);
    const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
    return targetPath !== resolvedBase && !targetPath.startsWith(baseWithSep) ? "403" : "ok";
  };
}

test("安全② 静态服务路径穿越：..%2F 解码后越界与同名前缀目录一律 403", () => {
  const guard = makeStaticGuard("C:/X");
  assert.equal(guard("index.html"), "ok");
  assert.equal(guard("sub/app.js"), "ok");
  // ..%2F..%2F 解码后即 ../../，越界
  assert.equal(guard("../../etc/passwd"), "403");
  assert.equal(guard("..\\..\\windows"), "403");
  // base=C:\X，请求解析到 C:\X-secret —— 同名前缀目录必须 403
  assert.equal(guard("../X-secret/leak.txt"), "403");
});

test("安全② serveFile 与 local-apps 边界判定在 main.js 真实存在", () => {
  assert.match(mainSrc, /function serveFile\(res, filePath\)/);
  assert.match(mainSrc, /targetPath !== resolvedBase && !targetPath\.startsWith\(baseWithSep\)/);
  assert.match(mainSrc, /sendJson\(res, 403, \{ error: "Access denied" \}\)/);
});

// ============ 安全③：本地 HTTP API 鉴权（401） ============
test("安全③ 七条敏感路由要求 token，否则 401", () => {
  // 七条受保护路由齐全
  assert.match(mainSrc, /const secureRoutes = \[([^\]]+)\]/);
  const m = mainSrc.match(/const secureRoutes = \[([^\]]+)\]/);
  const routes = m[1];
  for (const r of ["/cookies", "/events", "/broadcast", "/state", "/tabs", "/active-tab", "/active-task"]) {
    assert.ok(routes.includes(`"${r}"`), `secureRoutes 缺少 ${r}`);
  }
  // token 不匹配返回 401
  assert.match(mainSrc, /if \(token !== sessionToken\)/);
  assert.match(mainSrc, /res\.writeHead\(401/);
});

// ============ 安全④：token 注入白名单 + composedPath 外点关闭 ============
test("安全④ token 仅注入 local-web / 本地回环页面（白名单）", () => {
  // 注入条件门控：type === "local-web" || isLocalLoopbackUrl(currentUrl)
  assert.match(rendererSrc, /if \(type === "local-web" \|\| isLocalLoopbackUrl\(currentUrl\)\)/);
  // isLocalLoopbackUrl 仅放行 localhost / 127.0.0.1
  assert.match(rendererSrc, /\["localhost", "127\.0\.0\.1"\]\.includes\(parsed\.hostname\)/);
  // 不存在无差别注入（旧 bug：dom-ready 对所有 webview 注入）
  const injectMatches = rendererSrc.match(/__workbenchSessionToken = \$\{JSON\.stringify\(token\)\}/g) || [];
  assert.equal(injectMatches.length, 1, "token 注入点应唯一且受门控");
});

test("安全④ 外点关闭使用 composedPath（覆盖 webview 边界）", () => {
  assert.match(rendererSrc, /event\.composedPath\(\)/);
  assert.match(rendererSrc, /!path\.includes\(elements\.menuMorePop\)/);
});

// ============ V3.4 修复①：分类折叠尾部重激活不自动展开 ============
test("V3.4修复① activateTab 支持 autoExpand 且尾部重激活传 false", () => {
  // 函数签名带 autoExpand 默认 true
  assert.match(rendererSrc, /function activateTab\(id, \{ autoExpand = true \} = \{\}\)/);
  // 自动展开受 autoExpand 门控
  assert.match(rendererSrc, /if \(tab && autoExpand\)/);
  // renderTabs 尾部重激活显式传 autoExpand:false
  assert.match(rendererSrc, /activateTab\(validActiveTabId, \{ autoExpand: false \}\)/);
});

// ============ V3.4 修复②：测试残留标签过滤 ============
function makeIsTestResidueTab() {
  return (tab) => {
    const name = String(tab?.name || "");
    return /harness/i.test(name) || /<[a-z!\/]|onerror\s*=|__xss/i.test(name);
  };
}

test("V3.4修复② isTestResidueTab 过滤测试残留，保留用户标签", () => {
  const isResidue = makeIsTestResidueTab();
  // 测试残留：harness 命名、XSS 注入名
  assert.equal(isResidue({ name: "harness-tab-1" }), true);
  assert.equal(isResidue({ name: "E2E harness" }), true);
  assert.equal(isResidue({ name: "<img src=x onerror=alert(1)>" }), true);
  assert.equal(isResidue({ name: "__xss_probe" }), true);
  // 用户正常标签：不误删
  assert.equal(isResidue({ name: "评估" }), false);
  assert.equal(isResidue({ name: "Hermes 诊断" }), false);
  assert.equal(isResidue({ name: "我的本地项目" }), false);
  assert.equal(isResidue({ name: "" }), false);
  assert.equal(isResidue(null), false);
});

test("V3.4修复② readTabs 调用过滤并持久化清理后列表", () => {
  assert.match(rendererSrc, /function isTestResidueTab\(tab\)/);
  assert.match(rendererSrc, /const cleaned = saved\.filter\(\(tab\) => !isTestResidueTab\(tab\)\)/);
  assert.match(rendererSrc, /localStorage\.setItem\(storageKey, JSON\.stringify\(cleaned\)\)/);
});

// ============ V3.4 修复③：托盘悬停抖动 CSS（绝对定位 + visibility/opacity，几何零变化） ============
test("V3.4修复③ 托盘操作区改为绝对定位 + visibility/opacity 切换（无几何变化）", () => {
  // .rail-artifact 提供定位上下文
  assert.match(styleSrc, /\.rail-artifact \{ position: relative; \}/);
  // .ra-actions 绝对定位
  assert.match(styleSrc, /\.rail-artifact \.ra-actions \{[\s\S]*?position: absolute;[\s\S]*?\}/);
  // 默认 visibility:hidden + opacity:0，hover 显示
  assert.match(styleSrc, /\.rail-artifact \.ra-actions \{[\s\S]*?visibility: hidden;[\s\S]*?opacity: 0;[\s\S]*?\}/);
  assert.match(styleSrc, /\.rail-artifact:hover \.ra-actions \{ visibility: visible; opacity: 1; \}/);
  // 徽章用 visibility 隐藏（保留盒模型占位），不再 display:none
  assert.match(styleSrc, /\.rail-artifact:hover \.ra-badge \{ visibility: hidden; \}/);
  // 旧 bug 写法（display:none ↔ inline-flex 切换）已移除
  assert.doesNotMatch(styleSrc, /\.rail-artifact:hover \.ra-actions \{ display: inline-flex; \}/);
  assert.doesNotMatch(styleSrc, /\.rail-artifact:hover \.ra-badge \{ display: none; \}/);
});
