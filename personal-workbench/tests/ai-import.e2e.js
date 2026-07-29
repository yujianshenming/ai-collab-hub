// AI 导入隔离 E2E（问题 #1-#7 验收）：
// - 本地随机端口假网关（127.0.0.1），绝不访问真实公司网关；
// - 隔离 userData / weekly_tasks.json / 下载根目录，不读取真实 tasks/weekly_tasks.json；
// - 覆盖：规则预览分组、冲突候选选择、逐字段编辑、AI 解析合并（inferred 默认不勾选）、
//   真取消（网络请求 abort + 任务文件不被写入）、应用流程（明确确认后落盘）。
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const weeklyTasksPath = isolateWeeklyTasks("ai-import-e2e");
const userDataDir = process.env.PERSONAL_WORKBENCH_USER_DATA;
const downloadRoot = process.env.PERSONAL_WORKBENCH_DOWNLOAD_ROOT;
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

function readWeeklyFile() {
  return JSON.parse(fs.readFileSync(weeklyTasksPath, "utf8"));
}

async function waitFor(predicate, timeoutMs = 10000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ===== 假网关：mode=ok 返回合法模型响应；mode=hang 挂起并记录 abort =====
const gateway = { mode: "ok", chatRequests: 0, aborted: 0, auths: new Set() };

function buildModelContent() {
  // 对应发送的唯一一行「示例大学《AI课程》 1个 未完成」：
  // taskType 证据为 inferred（原文没有类型词）→ 候选默认不勾选（问题 #1/#2）
  return JSON.stringify({
    items: [{
      sourceLine: 1,
      task: {
        school: "示例大学", course: "AI课程", taskType: "capability-setup",
        quantity: 1, status: "pending", owner: "", weekday: "", note: ""
      },
      evidence: {
        school: { kind: "source", text: "示例大学" },
        course: { kind: "source", text: "AI课程" },
        taskType: { kind: "inferred", text: "" },
        quantity: { kind: "source", text: "1个" },
        status: { kind: "source", text: "未完成" }
      },
      confidence: 0.92
    }],
    unresolved: []
  });
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization) gateway.auths.add(req.headers.authorization);
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (req.method === "GET" && req.url.startsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/chat/completions")) {
      gateway.chatRequests += 1;
      if (gateway.mode === "hang") {
        // 不响应：等待客户端 abort；socket 关闭即视为请求被真正中止
        res.on("close", () => { gateway.aborted += 1; });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: buildModelContent() } }] }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
});

(async () => {
  let app;
  try {
    // 1) 假网关起在随机端口，环境变量注入 baseUrl + 假 key（仅测试用，不是真实密钥）
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    process.env.PERSONAL_WORKBENCH_LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PERSONAL_WORKBENCH_LLM_API_KEY = "e2e-fake-key-not-real";

    // 2) 隔离数据：两个同稳定键现有任务（触发冲突组）+ 待做任务 fixture
    fs.writeFileSync(weeklyTasksPath, JSON.stringify([
      { id: "exist-1", school: "示例大学", course: "冲突课程", taskType: "capability-setup", quantity: 2, status: "pending", owner: "李雷" },
      { id: "exist-2", school: "示例大学", course: "冲突课程", taskType: "capability-setup", quantity: 3, status: "pending", owner: "韩梅" }
    ], null, 2));
    const todoFixturePath = path.join(downloadRoot, "todo-fixture.txt");
    fs.writeFileSync(todoFixturePath, [
      "示例大学《新增课程》能力训练搭建 2个 未完成",
      "示例大学《冲突课程》能力训练搭建 1个 未完成",
      "示例大学《AI课程》 1个 未完成"
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(userDataDir, "workbench-prefs.json"), JSON.stringify({ todoFilePath: todoFixturePath }), "utf8");

    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root, env: { ...process.env } });
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForTimeout(1000);
    await page.evaluate(() => { window.confirm = () => true; });

    // 3) 打开导入预览：新增 1 / 冲突 1 / 无法解析 1（缺 taskType 进 unresolved，问题 #1）
    await page.click("#btn-import-todo");
    await page.waitForSelector("#import-preview-dialog[open]", { timeout: 10000 });
    const summary = await page.textContent("#import-preview-summary");
    record("preview groups: added 1 / conflicts 1 / unparsed 1", /新增 1 条.*疑似重复 1 条.*无法解析 1 条/.test(summary), summary.trim());
    const unparsedRow = await page.textContent(".import-row-unparsed");
    record("missing taskType line shows source line and reason", unparsedRow.includes("第 3 行") && unparsedRow.includes("缺少任务类型"), unparsedRow.trim());

    // 4) 冲突组（问题 #6）：默认不勾选、勾选框禁用、候选可见；选 radio 后才可导入
    const conflictBox = page.locator('input[type="checkbox"][data-group="conflicts"][data-index="0"]');
    record("conflict row is unchecked and disabled by default",
      !(await conflictBox.isChecked()) && (await conflictBox.isDisabled()));
    const candidateIds = await page.$$eval('input[data-conflict-index="0"]', (radios) => radios.map((radio) => radio.value));
    record("conflict candidates expose both existing task ids", candidateIds.includes("exist-1") && candidateIds.includes("exist-2"), candidateIds.join(","));
    await page.check('input[data-conflict-index="0"][value="exist-2"]');
    await waitFor(async () => (await conflictBox.isChecked()) && !(await conflictBox.isDisabled()), 5000, "conflict row selectable");
    record("conflict row becomes selectable only after explicit target choice", true);

    // 5) 逐字段编辑（问题 #2）：改数量 → 本地校验 → 字段来源标记 manual
    await page.click('button.import-edit-btn[data-edit-group="added"][data-edit-index="0"]');
    await page.fill('form.import-edit-form input[name="quantity"]', "5");
    await page.click('form.import-edit-form button[type="submit"]');
    await waitFor(async () => (await page.textContent("#import-preview-groups")).includes("5个"), 5000, "edited quantity");
    const editedGroupText = await page.textContent("#import-preview-groups");
    record("edited field re-validates and marks manual evidence", editedGroupText.includes("5个") && editedGroupText.includes("数量：手动"));

    // 6) 真取消（问题 #4）：hang 模式下取消必须 abort 网关连接，且任务文件不被写入
    gateway.mode = "hang";
    await page.click('#import-preview-groups button:has-text("使用 AI 解析所选行")');
    await page.waitForSelector('#import-preview-groups button:has-text("取消解析")', { timeout: 10000 });
    await page.click('#import-preview-groups button:has-text("取消解析")');
    await page.waitForFunction(
      () => document.querySelector(".import-ai-feedback")?.textContent.includes("已取消 AI 解析"),
      undefined, { timeout: 10000 }
    );
    record("cancel keeps rule results and reports cancellation", true);
    await waitFor(() => gateway.aborted >= 1, 10000, "gateway abort");
    record("cancel truly aborts the in-flight gateway request", gateway.aborted >= 1, `aborted=${gateway.aborted}`);
    record("weekly tasks file untouched after cancel", readWeeklyFile().length === 2);

    // 7) AI 成功解析并按原文合并（问题 #3）；含 inferred 字段的候选默认不勾选（问题 #1/#2）
    gateway.mode = "ok";
    await page.click('#import-preview-groups button:has-text("使用 AI 解析所选行")');
    await page.waitForFunction(
      () => document.querySelector(".import-ai-feedback")?.textContent.includes("AI 解析完成"),
      undefined, { timeout: 15000 }
    );
    const mergedText = await page.textContent("#import-preview-groups");
    record("AI row merged with origin badge and confidence", mergedText.includes("AI 解析") && mergedText.includes("92%"));
    record("AI inferred field is labelled in preview", mergedText.includes("类型：AI推断"));
    const aiRowBox = page.locator('input[type="checkbox"][data-group="added"][data-index="1"]');
    record("AI candidate with inferred field is unchecked by default", !(await aiRowBox.isChecked()));
    const unparsedCount = await page.$$eval(".import-row-unparsed", (rows) => rows.length);
    record("resolved line leaves the unparsed group", unparsedCount === 0, `unparsed=${unparsedCount}`);
    await aiRowBox.check();

    // 8) 应用流程：明确确认后写盘；冲突只更新用户选定的 exist-2
    record("weekly tasks file still original before apply", readWeeklyFile().length === 2);
    await page.click("#import-preview-apply");
    await waitFor(async () => !(await page.$("#import-preview-dialog[open]")), 10000, "dialog closed");
    await waitFor(() => readWeeklyFile().length === 4, 10000, "weekly tasks persisted");
    const tasks = readWeeklyFile();
    const exist1 = tasks.find((task) => task.id === "exist-1");
    const exist2 = tasks.find((task) => task.id === "exist-2");
    const addedTask = tasks.find((task) => task.course === "新增课程");
    const aiTask = tasks.find((task) => task.course === "AI课程");
    record("conflict updates only the user-chosen target", exist2?.quantity === 1 && exist1?.quantity === 2 && exist1?.owner === "李雷", JSON.stringify({ exist1: exist1?.quantity, exist2: exist2?.quantity }));
    record("edited added task persisted with manual quantity", addedTask?.quantity === 5 && addedTask?.taskType === "capability-setup");
    record("AI-parsed task persisted after explicit selection", aiTask?.taskType === "capability-setup" && aiTask?.quantity === 1);

    // 9) 网关安全面：只发假 key，全部请求都打到本地假网关
    record("gateway only ever saw the fake e2e key",
      gateway.auths.size === 1 && gateway.auths.has("Bearer e2e-fake-key-not-real"),
      [...gateway.auths].join("|"));
    record("exactly two chat requests reached the fake gateway", gateway.chatRequests === 2, `requests=${gateway.chatRequests}`);
  } catch (error) {
    record("AI import E2E completed", false, String(error?.stack || error));
  } finally {
    if (app) await app.close().catch(() => {});
    server.close();
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== AI import E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
