const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const weeklyTasksPath = isolateWeeklyTasks("subtask-switching-e2e");

async function waitForTask(page, expectedState) {
  await page.waitForFunction(async (state) => {
    const task = (await window.workbench.readWeeklyTasks())
      .find((candidate) => candidate.id === "switch-children");
    if (!task) return false;
    if (state === "child-one-running") {
      return task.status === "running"
        && task.subtasks?.[0]?.status === "running"
        && task.subtasks?.[1]?.status === "pending";
    }
    if (state === "parent-paused") return task.status === "paused";
    if (state === "both-paused") {
      return task.status === "paused"
        && task.subtasks?.[0]?.status === "paused"
        && task.subtasks?.[1]?.status === "paused";
    }
    if (state === "child-one-resumed") {
      return task.status === "running"
        && task.subtasks?.[0]?.status === "running"
        && task.subtasks?.[1]?.status === "paused";
    }
    if (state === "child-one-done") {
      return task.status === "paused"
        && task.subtasks?.[0]?.status === "done"
        && task.subtasks?.[1]?.status === "paused";
    }
    return false;
  }, expectedState, { timeout: 10000 });
}

(async () => {
  let app;
  try {
    fs.writeFileSync(weeklyTasksPath, JSON.stringify([
      {
        id: "switch-children",
        school: "Switch School",
        course: "Independent Children",
        quantity: 2,
        status: "pending",
        subtasks: [
          { index: 1, status: "pending" },
          { index: 2, status: "pending" }
        ]
      },
      {
        id: "legacy-paused-child",
        school: "Legacy School",
        course: "Paused Child Migration",
        quantity: 2,
        status: "paused",
        subtasks: [
          { index: 1, status: "running" },
          { index: 2, status: "pending" }
        ]
      }
    ], null, 2), "utf8");

    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root });
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForTimeout(800);

    const migratedLegacy = (await page.evaluate(() => window.workbench.readWeeklyTasks()))
      .find((candidate) => candidate.id === "legacy-paused-child");
    const migrationPassed = migratedLegacy?.status === "paused"
      && migratedLegacy?.subtasks?.[0]?.status === "paused"
      && migratedLegacy?.subtasks?.[1]?.status === "pending";
    console.log(`  [${migrationPassed ? "PASS" : "FAIL"}] legacy paused tasks release stale running children on startup`);
    if (!migrationPassed) {
      console.log(JSON.stringify(migratedLegacy, null, 2));
      process.exitCode = 1;
      return;
    }

    let card = page.locator('.task-card[data-id="switch-children"]');
    await card.locator(".tc-progress").click();
    await card.locator('.subtask-row[data-index="1"] [data-subtask-action="start"]').click();
    await waitForTask(page, "child-one-running");

    await page.locator("#rail-pause").click();
    await waitForTask(page, "parent-paused");

    card = page.locator('.task-card[data-id="switch-children"]');
    await card.locator(".tc-progress").click();
    await card.locator('.subtask-row[data-index="2"] [data-subtask-action="start"]').click();
    await page.waitForTimeout(600);

    const result = await page.evaluate(async () => {
      const task = (await window.workbench.readWeeklyTasks())
        .find((candidate) => candidate.id === "switch-children");
      return {
        task,
        pipeline: {
          active: pipelineState.active,
          taskId: pipelineState.taskId,
          activeSubtaskIndex: pipelineState.activeSubtaskIndex
        }
      };
    });

    const passed = result.task?.status === "running"
      && result.task?.subtasks?.[0]?.status === "paused"
      && result.task?.subtasks?.[1]?.status === "running"
      && result.pipeline.active
      && result.pipeline.taskId === "switch-children"
      && result.pipeline.activeSubtaskIndex === 2;

    console.log(`  [${passed ? "PASS" : "FAIL"}] pausing child one allows child two to start independently`);
    if (!passed) console.log(JSON.stringify(result, null, 2));
    if (!passed) {
      process.exitCode = 1;
      return;
    }

    await page.locator("#rail-pause").click();
    await waitForTask(page, "both-paused");

    card = page.locator('.task-card[data-id="switch-children"]');
    await card.locator(".tc-progress").click();
    await card.locator('.subtask-row[data-index="1"] [data-subtask-action="resume"]').click();
    await waitForTask(page, "child-one-resumed");

    await page.locator("#rail-finish").click();
    await page.locator("#finish-task-dialog").waitFor({ state: "visible" });
    await page.locator("#finish-task-submitted").click();
    await waitForTask(page, "child-one-done");

    const completedFirst = (await page.evaluate(() => window.workbench.readWeeklyTasks()))
      .find((candidate) => candidate.id === "switch-children");
    const completionPassed = completedFirst?.status === "paused"
      && completedFirst?.subtasks?.[0]?.status === "done"
      && completedFirst?.subtasks?.[1]?.status === "paused";
    console.log(`  [${completionPassed ? "PASS" : "FAIL"}] completing child one persists its completed state`);
    if (!completionPassed) console.log(JSON.stringify(completedFirst, null, 2));
    process.exitCode = completionPassed ? 0 : 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})();
