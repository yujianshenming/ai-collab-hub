// V3.4 自动化冒烟（测试工程师）—— 回归清单 §0.2
// 用 playwright-core 的 _electron.launch 启动应用，断言任务中心落地 + 零未捕获异常。
// 注意：冒烟阶段不打开终端面板（node-pty 在包装器控制台下可能 AttachConsole 崩溃）。
// 跑法：node tests/smoke.e2e.js
const path = require("path");
const { _electron: electron } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  const pageErrors = [];
  const consoleErrors = [];
  let app;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      cwd: ROOT
    });

    const page = await app.firstWindow({ timeout: 30000 });

    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // 等待渲染初始化
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1500);

    // 1) 窗口标题
    const title = await page.title();
    record("窗口标题为「个人工作台」", title.includes("个人工作台"), `实际="${title}"`);

    // 2) 任务中心为默认落地页（#task-center-view 可见）
    const taskCenterVisible = await page.locator("#task-center-view").isVisible().catch(() => false);
    record("#task-center-view 可见（默认落地页）", taskCenterVisible);

    // 3) 统计卡数字非空
    const statTotal = (await page.locator("#stat-total").textContent().catch(() => "")) || "";
    record("统计卡 #stat-total 数字非空", statTotal.trim().length > 0, `值="${statTotal.trim()}"`);

    // 4) 侧边栏 nav-task-center 与状态栏 sb-terminal 可见
    const navVisible = await page.locator("#nav-task-center").isVisible().catch(() => false);
    record("#nav-task-center 可见", navVisible);
    const sbTerminalVisible = await page.locator("#sb-terminal").isVisible().catch(() => false);
    record("#sb-terminal 可见", sbTerminalVisible);

    // 5) 卡片舱相关容器存在于 DOM（V3.4 新增；活动任务前可能 hidden，只校验存在）
    const railCardsCount = await page.locator("#rail-cards").count().catch(() => 0);
    record("#rail-cards 容器存在于 DOM", railCardsCount > 0);

    // 再等一会观察异步异常（fs.watch/本地服务/扩展加载等）
    await page.waitForTimeout(2500);

    // 6) 零未捕获异常
    record("3 秒内零 pageerror", pageErrors.length === 0, pageErrors.length ? pageErrors.join(" | ") : "");
    record("零 console.error", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 5).join(" | ") : "");

  } catch (e) {
    record("应用启动", false, String(e && e.stack || e));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("\n===== 冒烟结果 =====");
  console.log(`总计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? " — " + f.detail : ""}`);
    process.exit(1);
  } else {
    console.log("全部通过。");
    process.exit(0);
  }
})();
