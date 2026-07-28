const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const weeklyTasksPath = isolateWeeklyTasks("task-focus-view-e2e");
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function waitForPageCondition(page, predicate, argument, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(predicate, argument)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`page condition timed out after ${timeout}ms`);
}

(async () => {
  let app;
  try {
    const tasks = Array.from({ length: 8 }, (_item, index) => ({
      id: `focus-${index + 1}`,
      school: index < 2 ? "重复大学" : `学校 ${index + 1}`,
      course: index < 2 ? "重复课程" : `课程 ${index + 1}`,
      taskType: "capability-setup",
      quantity: 1,
      status: "pending",
      dueDate: `2099-01-${String(index + 1).padStart(2, "0")}`,
      subtasks: [{ index: 1, status: "pending" }]
    }));
    fs.writeFileSync(weeklyTasksPath, JSON.stringify(tasks, null, 2), "utf8");

    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root });
    const page = await app.firstWindow({ timeout: 30000 });
    page.setDefaultTimeout(10000);
    await page.waitForTimeout(900);

    const initial = await page.evaluate(() => ({
      focusActive: document.querySelector('[data-task-view="focus"]')?.classList.contains("active"),
      cards: document.querySelectorAll(".task-card").length,
      summary: document.querySelector("#task-view-summary")?.textContent || "",
      duplicateVisible: !document.querySelector("#task-duplicate-alert")?.hidden,
      duplicateSummary: document.querySelector("#task-duplicate-summary")?.textContent || ""
    }));
    record(
      "task center opens in a six-item focus view",
      initial.focusActive && initial.cards === 6 && initial.summary.includes("6 / 8"),
      JSON.stringify(initial)
    );
    record(
      "exact duplicate records are flagged without being merged",
      initial.duplicateVisible && initial.duplicateSummary.includes("1 组"),
      initial.duplicateSummary
    );

    await page.locator('[data-task-view="all"]').click();
    await waitForPageCondition(page, () => document.querySelectorAll(".task-card").length === 8);
    record("all-tasks view restores every open task", true);

    await page.locator('[data-task-view="focus"]').click();
    await page.locator("#task-search").fill("课程 8");
    await page.waitForTimeout(220);
    const filtered = await page.evaluate(() => ({
      cards: [...document.querySelectorAll(".task-card")].map((card) => card.dataset.id),
      summary: document.querySelector("#task-view-summary")?.textContent || ""
    }));
    record(
      "explicit search can find a task outside the focus shortlist",
      filtered.cards.length === 1 && filtered.cards[0] === "focus-8" && filtered.summary.includes("筛选结果 1 项"),
      JSON.stringify(filtered)
    );
  } catch (error) {
    record("task focus view E2E completed", false, String(error?.stack || error));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== Task focus view E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
