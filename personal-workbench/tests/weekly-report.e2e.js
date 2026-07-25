const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const weeklyTasksPath = isolateWeeklyTasks("weekly-report-e2e");
const weeklyReportsPath = path.join(process.env.PERSONAL_WORKBENCH_USER_DATA, "weekly-reports.json");
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function launch() {
  const app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root });
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForTimeout(900);
  return { app, page };
}

(async () => {
  let app;
  const pageErrors = [];
  try {
    fs.writeFileSync(weeklyTasksPath, JSON.stringify([
      {
        id: "report-task-complete",
        school: "广东药科大学",
        course: "医学人文导论",
        taskType: "capability-setup",
        quantity: 4,
        status: "completed",
        subtasks: [
          { index: 1, status: "done" },
          { index: 2, status: "done" },
          { index: 3, status: "done" },
          { index: 4, status: "done" }
        ]
      },
      {
        id: "report-task-progress",
        school: "河北师范大学",
        course: "数据结构与算法",
        taskType: "capability-edit",
        quantity: 2,
        status: "paused",
        subtasks: [
          { index: 1, status: "done" },
          { index: 2, status: "pending" }
        ]
      }
    ], null, 2), "utf8");

    ({ app, page } = await launch());
    page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));
    await page.locator("#nav-weekly-report").click();
    await page.locator("#weekly-report-view").waitFor({ state: "visible" });
    await page.locator("#report-generate").click();
    await page.locator("#report-rows-body tr").nth(1).waitFor({ state: "visible" });

    const generated = await page.evaluate(() => ({
      rowCount: document.querySelectorAll("#report-rows-body tr").length,
      firstCourse: document.querySelector('#report-rows-body tr input[data-report-field="course"]')?.value,
      firstProgress: document.querySelector('#report-rows-body tr input[data-report-field="progress"]')?.value,
      previewHasTable: Boolean(document.querySelector("#report-preview table"))
    }));
    record(
      "weekly report draft maps current tasks into editable rows",
      generated.rowCount === 2 && generated.firstCourse === "医学人文导论" && generated.firstProgress === "100%" && generated.previewHasTable,
      JSON.stringify(generated)
    );

    // 添加一行后删除：操作列删除按钮应可见且立刻减少行数
    await page.locator("#report-add-row").click();
    await page.waitForFunction(() => document.querySelectorAll("#report-rows-body tr[data-report-row-index]").length === 3);
    const afterAdd = await page.evaluate(() => ({
      rowCount: document.querySelectorAll("#report-rows-body tr[data-report-row-index]").length,
      removeButtons: document.querySelectorAll('#report-rows-body [data-report-action="remove-row"]').length,
      countLabel: document.querySelector("#report-row-count")?.textContent
    }));
    record(
      "manual add row increases editable rows and exposes delete buttons",
      afterAdd.rowCount === 3 && afterAdd.removeButtons === 3 && afterAdd.countLabel === "3 项",
      JSON.stringify(afterAdd)
    );
    await page.locator('#report-rows-body tr[data-report-row-index="2"] [data-report-action="remove-row"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#report-rows-body tr[data-report-row-index]").length === 2);
    const afterDelete = await page.evaluate(() => ({
      rowCount: document.querySelectorAll("#report-rows-body tr[data-report-row-index]").length,
      countLabel: document.querySelector("#report-row-count")?.textContent,
      dirty: document.querySelector("#report-save-state")?.textContent,
      previewRows: document.querySelectorAll("#report-preview table tbody tr").length
    }));
    record(
      "delete row removes the target row and updates count/preview immediately",
      afterDelete.rowCount === 2
        && afterDelete.countLabel === "2 项"
        && afterDelete.dirty === "未保存"
        && afterDelete.previewRows >= 2,
      JSON.stringify(afterDelete)
    );

    await page.locator("#report-author").fill("刘毅");
    await page.locator("#report-title").fill("M7W2周报测试");
    await page.locator('#report-rows-body tr').nth(1).locator('textarea[data-report-field="note"]').fill("下周继续跟进第二个子任务");
    await page.locator("#report-add-nonquantified").click();
    await page.locator('#report-nonquantified-list textarea[data-report-field="text"]').last().fill("完成企业微信文档周报流程验证");
    await page.locator("#report-add-issue").click();
    await page.locator('#report-issues-list textarea[data-report-field="text"]').last().fill("希望后续支持按项目筛选任务");
    await page.locator("#report-save").click();
    await page.waitForFunction(() => document.querySelector("#report-save-state")?.textContent === "已保存");

    const persisted = await page.evaluate(() => window.workbench.readWeeklyReports());
    const saved = persisted.find((report) => report.title === "M7W2周报测试");
    record(
      "weekly report saves manual metadata and supplemental sections",
      saved?.author === "刘毅"
        && saved?.rows?.length === 2
        && saved?.rows?.[1]?.note === "下周继续跟进第二个子任务"
        && saved?.nonQuantified?.[0]?.text === "完成企业微信文档周报流程验证"
        && saved?.issues?.[0]?.text === "希望后续支持按项目筛选任务",
      JSON.stringify(saved)
    );

    await page.locator("#report-copy").click();
    await page.waitForTimeout(250);
    const clipboard = await app.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      html: clipboard.readHTML()
    }));
    record(
      "copy action writes both plain text and rich HTML for enterprise WeChat docs",
      clipboard.text.includes("M7W2周报测试") && clipboard.text.includes("广东药科大学") && clipboard.html.includes("<table") && clipboard.html.includes("本周工作内容"),
      JSON.stringify({ textLength: clipboard.text.length, htmlLength: clipboard.html.length })
    );

    if (await page.locator("#report-copy-table").count()) {
      await page.locator("#report-copy-table").click();
      await page.waitForTimeout(250);
      const tableClipboard = await app.evaluate(({ clipboard }) => ({
        text: clipboard.readText(),
        html: clipboard.readHTML()
      }));
      record(
        "table copy writes HTML table and TSV for existing table paste",
        tableClipboard.text.includes("\t")
          && tableClipboard.text.includes("广东药科大学")
          && tableClipboard.html.includes('data-workbench-weekly-report-table="true"')
          && tableClipboard.html.includes("<th")
          && tableClipboard.html.includes("<td"),
        JSON.stringify({ textLength: tableClipboard.text.length, htmlLength: tableClipboard.html.length })
      );
    }

    const currentPeriod = await page.locator("#report-period").inputValue();
    await page.locator("#report-save-default-author").click();
    await page.waitForTimeout(200);
    const savedDefaults = await page.evaluate(async () => {
      const prefs = await window.workbench.getWorkbenchPrefs();
      return prefs?.weeklyReportDefaults || null;
    });
    record(
      "save-default-author stores weeklyReportDefaults.author in prefs",
      savedDefaults?.author === "刘毅",
      JSON.stringify(savedDefaults)
    );

    await page.locator("#report-period-prev").click();
    await page.waitForTimeout(350);
    const previousPeriod = await page.locator("#report-period").inputValue();
    const prevAuthor = await page.locator("#report-author").inputValue();
    record(
      "previous-week control opens an adjacent period draft with default author",
      Boolean(previousPeriod) && previousPeriod !== currentPeriod && prevAuthor === "刘毅",
      JSON.stringify({ currentPeriod, previousPeriod, prevAuthor })
    );

    await page.locator("#report-title").fill("历史周次草稿");
    await page.locator("#report-save").click();
    await page.waitForFunction(() => document.querySelector("#report-save-state")?.textContent === "已保存");
    await page.waitForFunction(() => document.querySelectorAll("#report-history-list .report-history-item").length >= 2);
    const historyCount = await page.locator("#report-history-list .report-history-item").count();
    record("history list shows at least two saved periods", historyCount >= 2, `count=${historyCount}`);

    await page.locator(`#report-history-list .report-history-item[data-report-period="${currentPeriod}"]`).click();
    await page.waitForTimeout(300);
    const restoredTitle = await page.locator("#report-title").inputValue();
    const restoredAuthor = await page.locator("#report-author").inputValue();
    record(
      "history item switches back to the original saved weekly report",
      restoredTitle === "M7W2周报测试" && restoredAuthor === "刘毅",
      JSON.stringify({ restoredTitle, restoredAuthor })
    );

    await page.locator("#report-generate").click();
    await page.waitForTimeout(200);
    const noteAfterGenerate = await page.locator('#report-rows-body tr').nth(1).locator('textarea[data-report-field="note"]').inputValue();
    record(
      "regenerate from tasks keeps manual row notes",
      noteAfterGenerate === "下周继续跟进第二个子任务",
      noteAfterGenerate
    );

    await app.close();
    app = null;
    ({ app, page } = await launch());
    const afterRestart = await page.evaluate(() => window.workbench.readWeeklyReports());
    const restored = afterRestart.find((report) => report.title === "M7W2周报测试");
    record(
      "weekly report draft survives an Electron restart",
      restored?.author === "刘毅" && restored?.issues?.[0]?.text === "希望后续支持按项目筛选任务",
      JSON.stringify(restored)
    );
    record("no renderer page errors during weekly report flow", pageErrors.length === 0, pageErrors.join(" | "));
    record("weekly report storage file is written under isolated user data", fs.existsSync(weeklyReportsPath));
  } catch (error) {
    record("weekly report E2E completed", false, String(error?.stack || error));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== Weekly report E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
