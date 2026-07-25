const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const weeklyTasksPath = isolateWeeklyTasks("task-controls-e2e");
const tasksRoot = path.join(process.env.PERSONAL_WORKBENCH_DOWNLOAD_ROOT, "tasks");
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function waitForTask(page, taskId, state) {
  return page.waitForFunction(async ({ id, expectedState }) => {
    const tasks = await window.workbench.readWeeklyTasks();
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) return false;
    if (expectedState === "manual-completed") {
      return task.status === "completed" && task.subtasks?.[0]?.status === "done";
    }
    if (expectedState === "child-two-running") {
      return task.status === "running" && task.subtasks?.[0]?.status === "pending" && task.subtasks?.[1]?.status === "running";
    }
    if (expectedState === "child-two-done") {
      return task.status === "paused" && task.subtasks?.[0]?.status === "pending" && task.subtasks?.[1]?.status === "done";
    }
    if (expectedState === "child-one-running") {
      return task.status === "running" && task.subtasks?.[0]?.status === "running" && task.subtasks?.[1]?.status === "done";
    }
    if (expectedState === "all-done") {
      return task.status === "completed" && task.subtasks?.every((subtask) => subtask.status === "done");
    }
    return false;
  }, { id: taskId, expectedState: state }, { timeout: 10000 });
}

(async () => {
  let app;
  const pageErrors = [];
  try {
    fs.writeFileSync(weeklyTasksPath, JSON.stringify([
      {
        id: "manual-status",
        school: "Status School",
        course: "Manual State",
        quantity: 1,
        status: "pending",
        subtasks: [{ index: 1, status: "pending" }]
      },
      {
        id: "multi-child",
        school: "Child School",
        course: "Independent Children",
        quantity: 2,
        status: "pending",
        subtasks: [
          { index: 1, status: "pending" },
          { index: 2, status: "pending" }
        ]
      }
    ], null, 2), "utf8");

    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root });
    const page = await app.firstWindow({ timeout: 30000 });
    page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));
    await page.waitForTimeout(1000);

    const manualCard = page.locator('.task-card[data-id="manual-status"]');
    await manualCard.locator(".tc-menu-toggle").click();
    await manualCard.locator(".task-edit").click();
    await page.locator("#task-dialog").waitFor({ state: "visible" });
    await page.locator("#task-status").selectOption("completed");
    await page.locator('#task-form button[type="submit"]').click();
    await waitForTask(page, "manual-status", "manual-completed");
    const manuallyCompleted = (await page.evaluate(() => window.workbench.readWeeklyTasks()))
      .find((task) => task.id === "manual-status");
    record(
      "task editor can mark a task completed without running the pipeline",
      manuallyCompleted?.status === "completed" && manuallyCompleted?.subtasks?.[0]?.status === "done",
      JSON.stringify(manuallyCompleted)
    );

    // 搜索 / 归档：只影响任务中心网格，不改 status 与产物路径
    await page.locator("#task-search").fill("Independent");
    await page.waitForTimeout(220);
    const searchVisible = await page.evaluate(() => ({
      multi: Boolean(document.querySelector('.task-card[data-id="multi-child"]')),
      manual: Boolean(document.querySelector('.task-card[data-id="manual-status"]')),
      total: document.querySelector("#stat-total")?.textContent
    }));
    record(
      "task search filters the grid while stats stay global",
      searchVisible.multi && !searchVisible.manual && searchVisible.total === "2",
      JSON.stringify(searchVisible)
    );
    await page.locator("#task-search").fill("");
    await page.waitForTimeout(220);

    const multiMenuCard = page.locator('.task-card[data-id="multi-child"]');
    await multiMenuCard.locator(".tc-menu-toggle").click();
    await multiMenuCard.locator(".task-archive").click();
    await page.waitForFunction(async () => {
      const tasks = await window.workbench.readWeeklyTasks();
      const multi = tasks.find((task) => task.id === "multi-child");
      return Boolean(multi?.archived);
    }, null, { timeout: 5000 });
    const archivedState = await page.evaluate(async () => {
      const tasks = await window.workbench.readWeeklyTasks();
      const multi = tasks.find((task) => task.id === "multi-child");
      return {
        archived: Boolean(multi?.archived),
        status: multi?.status,
        visible: Boolean(document.querySelector('.task-card[data-id="multi-child"]')),
        total: document.querySelector("#stat-total")?.textContent
      };
    });
    record(
      "archiving hides the card by default without changing status",
      archivedState.archived && archivedState.status === "pending" && !archivedState.visible && archivedState.total === "2",
      JSON.stringify(archivedState)
    );
    await page.locator('#task-filter-chips [data-status-filter="archived"]').click();
    await page.waitForTimeout(200);
    const archivedOnlyVisible = await page.evaluate(() => Boolean(document.querySelector('.task-card[data-id="multi-child"]')));
    record("archived filter shows archived tasks", archivedOnlyVisible);
    const archivedCard = page.locator('.task-card[data-id="multi-child"]');
    await archivedCard.locator(".tc-menu-toggle").click();
    await archivedCard.locator(".task-archive").click();
    await page.waitForTimeout(300);
    await page.locator('#task-filter-chips [data-status-filter="all"]').click();
    await page.waitForTimeout(200);
    const unarchivedState = await page.evaluate(async () => {
      const tasks = await window.workbench.readWeeklyTasks();
      const multi = tasks.find((task) => task.id === "multi-child");
      return {
        archived: Boolean(multi?.archived),
        visible: Boolean(document.querySelector('.task-card[data-id="multi-child"]'))
      };
    });
    record(
      "unarchive restores the card in the default list",
      !unarchivedState.archived && unarchivedState.visible,
      JSON.stringify(unarchivedState)
    );

    const multiCard = page.locator('.task-card[data-id="multi-child"]');
    await multiCard.locator(".tc-progress").click();
    await multiCard.locator('.subtask-row[data-index="2"] .subtask-action[data-subtask-action="start"]').click();
    await waitForTask(page, "multi-child", "child-two-running");
    const firstRun = await page.evaluate(() => ({
      active: typeof pipelineState !== "undefined" && pipelineState.active,
      activeSubtaskIndex: typeof pipelineState !== "undefined" ? pipelineState.activeSubtaskIndex : null
    }));
    record("a selected child starts independently", firstRun.active && firstRun.activeSubtaskIndex === 2, JSON.stringify(firstRun));

    await page.locator("#rail-finish").click();
    await page.locator("#finish-task-dialog").waitFor({ state: "visible" });
    const dialogMetrics = await page.evaluate(() => {
      const dialog = document.querySelector("#finish-task-dialog");
      const form = document.querySelector("#finish-task-form");
      const dialogRect = dialog.getBoundingClientRect();
      const buttonRects = [...dialog.querySelectorAll(".modal-actions > button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom
        };
      });
      return {
        dialogOverflow: getComputedStyle(dialog).overflow,
        formOverflowY: getComputedStyle(form).overflowY,
        buttonsInside: buttonRects.every((rect) => (
          rect.left >= dialogRect.left - 1
          && rect.right <= dialogRect.right + 1
          && rect.top >= dialogRect.top - 1
          && rect.bottom <= dialogRect.bottom + 1
        ))
      };
    });
    record(
      "finish dialog keeps its content and actions inside the rounded viewport",
      dialogMetrics.dialogOverflow === "hidden" && dialogMetrics.formOverflowY === "auto" && dialogMetrics.buttonsInside,
      JSON.stringify(dialogMetrics)
    );
    await page.locator("#finish-task-submitted").click();
    await waitForTask(page, "multi-child", "child-two-done");
    const afterOneChild = (await page.evaluate(() => window.workbench.readWeeklyTasks()))
      .find((task) => task.id === "multi-child");
    record(
      "ending one child pauses the parent and preserves the other child",
      afterOneChild?.status === "paused"
        && afterOneChild?.subtasks?.[0]?.status === "pending"
        && afterOneChild?.subtasks?.[1]?.status === "done"
        && Boolean(afterOneChild?.taskFolder)
        && fs.existsSync(afterOneChild.taskFolder),
      JSON.stringify(afterOneChild)
    );

    const pausedCard = page.locator('.task-card[data-id="multi-child"]');
    await pausedCard.locator(".tc-progress").click();
    await pausedCard.locator('.subtask-row[data-index="1"] .subtask-action[data-subtask-action="start"]').click();
    await waitForTask(page, "multi-child", "child-one-running");
    await page.locator("#rail-finish").click();
    await page.locator("#finish-task-submitted").click();
    await waitForTask(page, "multi-child", "all-done");
    const fullyCompleted = (await page.evaluate(() => window.workbench.readWeeklyTasks()))
      .find((task) => task.id === "multi-child");
    record(
      "only the final child completes the parent and cleans its folder",
      fullyCompleted?.status === "completed"
        && fullyCompleted?.subtasks?.every((subtask) => subtask.status === "done")
        && !fullyCompleted?.taskFolder,
      JSON.stringify(fullyCompleted)
    );
    record("no renderer page errors during task lifecycle", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (error) {
    record("task controls E2E completed", false, String(error?.stack || error));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== Task controls E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
