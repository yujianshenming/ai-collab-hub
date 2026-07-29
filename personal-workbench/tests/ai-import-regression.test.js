// AI 导入七问题修复回归（2026-07-28）：#1/#2/#3/#4/#6/#7 的主进程/preload/renderer 契约
// 纯静态/逻辑层校验，不启动应用；行为层由 tests/llm-task-parser.test.js 与 tests/ai-import.e2e.js 覆盖
// 跑法：node --test tests/ai-import-regression.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const preloadSrc = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
const rendererSrc = fs.readFileSync(path.join(ROOT, "renderer.js"), "utf8");
const styleSrc = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");

// ============ 问题 #7：未知模型 ID 不得发送到公司网关 ============

test("#7 ai:test-model 与 ai:parse-todo-lines 都经过本地注册表校验", () => {
  // ai:test-model：sanitize 后必须 isKnownModelId，未知模型直接拒绝
  const testModelBlock = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("ai:test-model"'));
  assert.ok(testModelBlock.includes("llmRegistry.isKnownModelId(clean)"), "ai:test-model 缺少注册表校验");
  assert.ok(testModelBlock.includes("未注册的模型，已拒绝请求"), "ai:test-model 缺少拒绝文案");

  // ai:parse-todo-lines：显式传入的模型必须 sanitize + isKnownModelId
  const parseStart = mainSrc.indexOf('ipcMain.handle("ai:parse-todo-lines"');
  assert.ok(parseStart > 0, "缺少 ai:parse-todo-lines 通道");
  const parseBlock = mainSrc.slice(parseStart, mainSrc.indexOf('ipcMain.handle("ai:cancel-parse"'));
  assert.ok(parseBlock.includes("llmRegistry.sanitizeModelId(rawModel)"), "parse 通道缺少模型 sanitize");
  assert.ok(parseBlock.includes("llmRegistry.isKnownModelId(clean)"), "parse 通道缺少注册表校验");
  assert.ok(parseBlock.includes("未注册的模型，已拒绝请求"), "parse 通道缺少拒绝分支");
  // 未传模型时回落到已规范化的默认模型（保持兼容行为）
  assert.ok(parseBlock.includes("loadWorkbenchPrefs().llmDefaultModel"), "缺少默认模型回落");
});

test("#7 Base URL 不接受 renderer 注入：仅 127.0.0.1 环境变量例外（E2E 假网关）", () => {
  assert.match(mainSrc, /function llmBaseUrlOverride\(\)/);
  assert.ok(mainSrc.includes('raw.startsWith("http://127.0.0.1:")'), "override 必须限定回环地址");
  // 逻辑复刻：非回环地址一律回落空串 → createLlmClient 使用固定公司网关
  const makeOverride = (envValue) => {
    const raw = String(envValue || "");
    return raw.startsWith("http://127.0.0.1:") ? raw : "";
  };
  assert.equal(makeOverride("http://127.0.0.1:8931"), "http://127.0.0.1:8931");
  assert.equal(makeOverride("http://evil.example.com"), "");
  assert.equal(makeOverride("https://127.0.0.1:8931"), "");
  assert.equal(makeOverride("http://127.0.0.2:80"), "");
  assert.equal(makeOverride(""), "");
});

// ============ 问题 #4：真取消（AbortController + cancel IPC） ============

test("#4 主进程保存 AbortController，新请求/取消请求会真正 abort", () => {
  assert.ok(mainSrc.includes("const aiParseControllers = new Map()"), "缺少进行中请求登记表");
  assert.match(mainSrc, /const abortAiParseForSender = \(senderId\) =>/);
  assert.ok(mainSrc.includes('entry.controller.abort(new Error("cancelled"))'), "缺少 abort 调用");
  const parseBlock = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("ai:parse-todo-lines"'));
  assert.ok(parseBlock.includes("abortAiParseForSender(event.sender.id)"), "新请求必须先中止旧请求");
  assert.ok(parseBlock.includes("new AbortController()"), "缺少 AbortController");
  assert.ok(parseBlock.includes("signal: controller.signal"), "signal 未传给解析器");
  // 取消通道：只允许取消自己 sender 的请求，重复取消幂等
  assert.ok(mainSrc.includes('ipcMain.handle("ai:cancel-parse"'), "缺少 ai:cancel-parse 通道");
  const cancelBlock = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("ai:cancel-parse"'));
  assert.ok(cancelBlock.includes("entry.senderId === event.sender.id"), "cancel 缺少 sender 校验");
  assert.ok(cancelBlock.includes("{ ok: true, cancelled: false }"), "cancel 必须幂等返回");
});

test("#4 preload 暴露 aiCancelParse，renderer 在关闭/取消时调用", () => {
  assert.match(preloadSrc, /aiCancelParse: \(requestId\) => ipcRenderer\.invoke\("ai:cancel-parse", requestId\)/);
  // renderer：requestId 生成 + 取消入口 + 关闭预览时取消
  assert.match(rendererSrc, /const requestId = `ai-\$\{Date\.now\(\)\}/);
  assert.match(rendererSrc, /async function cancelAiParse\(\)/);
  assert.ok(rendererSrc.includes("window.workbench.aiCancelParse?.(requestId)"), "cancelAiParse 未走 IPC");
  assert.ok(
    rendererSrc.includes("Promise.resolve(window.workbench.aiCancelParse?.(importAiRequestId)).catch(() => {})"),
    "关闭预览必须真取消进行中的请求"
  );
  // 迟到保护：代际令牌判断必须先于任何状态修改
  const lateGuard = rendererSrc.indexOf("if (token !== importPreviewToken || !importPreviewState || !importPreviewSource) return;");
  const busyReset = rendererSrc.indexOf("importAiBusy = false;", rendererSrc.indexOf("async function runAiParseOnLines"));
  assert.ok(lateGuard > 0 && lateGuard < busyReset, "迟到结果保护必须在 busy 重置之前");
  // 取消后不改任务/预览数据，仅提示
  assert.ok(rendererSrc.includes("已取消 AI 解析（规则解析结果已保留）"), "缺少取消提示分支");
});

// ============ 问题 #3：AI 结果按原文合并，不整体覆盖 ============

test("#3 renderer 合并 AI 结果而非替换整个任务列表", () => {
  assert.match(rendererSrc, /function mergeAiResultIntoPreview\(result, sentEntries\)/);
  assert.match(rendererSrc, /function rebuildImportPreviewState\(\{ preserveSelection = false \} = \{\}\)/);
  // 旧缺陷（mode === "all" 时整体替换）不得回归
  assert.ok(!rendererSrc.includes("importPreviewSource.tasks = items.map"), "禁止整体替换任务列表");
  // 已有结果的原文行跳过，不覆盖规则解析
  assert.ok(rendererSrc.includes("knownTexts.has(sourceText)"), "缺少原文去重保护");
  // 合并后按稳定键恢复用户勾选
  assert.ok(rendererSrc.includes("rebuildImportPreviewState({ preserveSelection: true })"), "合并必须保留用户勾选");
  // 无法解析组逐行显示行号与原因（哪些行失败/未发送）
  assert.ok(rendererSrc.includes("`第 ${entry.sourceLine} 行：${entry.sourceText}`"), "无法解析组缺少行号显示");
});

// ============ 问题 #2：字段来源与逐字段编辑 ============

test("#2 预览展示原文/来源/置信度/警告，可逐字段编辑并重新过 Schema 校验", () => {
  assert.ok(rendererSrc.includes("IMPORT_EVIDENCE_LABELS"), "缺少来源标记文案表");
  assert.ok(rendererSrc.includes("import-evidence import-evidence-"), "缺少来源标记渲染");
  assert.ok(rendererSrc.includes("AI 解析${Number.isFinite(meta.confidence)"), "缺少 AI 置信度徽标");
  assert.match(rendererSrc, /function saveImportRowEdit\(groupKey, index, form\)/);
  // 编辑保存必须重新走本地 Schema 校验，失败不落盘
  const saveBlock = rendererSrc.slice(rendererSrc.indexOf("function saveImportRowEdit"));
  assert.ok(saveBlock.includes("validateImportedTask(edited)"), "编辑保存缺少 Schema 校验");
  assert.ok(saveBlock.includes('{ kind: "manual", text: "" }'), "手动修改的字段必须标记 manual");
  // 应用前明确确认
  assert.ok(rendererSrc.includes("确认导入所选任务？"), "应用前缺少明确确认");
});

// ============ 问题 #1/#6：冲突组与默认勾选纪律 ============

test("#1/#6 冲突行默认不勾选、选定目标任务后才可导入", () => {
  assert.ok(rendererSrc.includes('renderImportPreviewGroup("conflicts", "疑似重复/冲突", conflicts)'), "预览缺少冲突组");
  // 冲突行未选 targetId 时勾选框禁用
  assert.ok(rendererSrc.includes("isConflict && !row.targetId"), "冲突行缺少禁用守卫");
  // 应用时只更新用户明确选定的目标
  assert.ok(rendererSrc.includes("row.selected && row.targetId"), "冲突行必须 targetId 才计入导入");
  assert.ok(rendererSrc.includes("weeklyTasks.find((task) => task.id === row.targetId)"), "冲突更新必须按 targetId 定位");
  // 低置信度/含推断字段的候选默认不勾选
  assert.ok(rendererSrc.includes("lowTrust"), "缺少低置信度默认不勾选标记");
  // 缺类型行的界面警示
  assert.ok(rendererSrc.includes("缺少任务类型，请先编辑指定类型"), "缺少缺类型警示文案");
});

test("样式与导入链路接线：parseTodoDocument 契约 + 新增样式类存在", () => {
  assert.ok(rendererSrc.includes("openImportPreview(parseTodoDocument(result.text), result.text)"), "导入必须走 parseTodoDocument 契约");
  for (const cls of [".import-source-text", ".import-evidence", ".import-conflict-list", ".import-edit-form", ".import-edit-error"]) {
    assert.ok(styleSrc.includes(cls), `style.css 缺少 ${cls}`);
  }
});
