const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const weeklyTasksPath = isolateWeeklyTasks("task-persistence-e2e");
const tasksRoot = path.join(process.env.PERSONAL_WORKBENCH_DOWNLOAD_ROOT, "tasks");
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function launch() {
  const app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root });
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForTimeout(750);
  return { app, page };
}

(async () => {
  let runningApp;
  try {
    fs.writeFileSync(weeklyTasksPath, JSON.stringify([{
      id: "orphan-running",
      school: "test",
      course: "restart",
      status: "running",
      step: "testing"
    }], null, 2));
    let launched = await launch();
    runningApp = launched.app;
    const reconciled = await launched.page.evaluate(() => window.workbench.readWeeklyTasks());
    record("orphan running task becomes paused after restart", reconciled[0]?.status === "paused", JSON.stringify(reconciled[0]));
    await runningApp.close();
    runningApp = null;
    record("reconciled state is persisted atomically", JSON.parse(fs.readFileSync(weeklyTasksPath, "utf8"))[0]?.status === "paused");

    const cleanupFolder = path.join(tasksRoot, "cleanup-pending");
    const deleteFolder = path.join(tasksRoot, "delete-pending");
    fs.mkdirSync(cleanupFolder, { recursive: true });
    fs.mkdirSync(deleteFolder, { recursive: true });
    fs.writeFileSync(path.join(cleanupFolder, "dialogue.json"), "{}", "utf8");
    fs.writeFileSync(path.join(deleteFolder, "eval_report.pdf"), "fixture", "utf8");
    fs.writeFileSync(weeklyTasksPath, JSON.stringify([
      {
        id: "cleanup-pending",
        school: "test",
        course: "cleanup",
        status: "completed",
        step: "report",
        cleanupPending: true,
        taskFolder: cleanupFolder,
        chatLogPath: path.join(cleanupFolder, "dialogue.json")
      },
      {
        id: "delete-pending",
        school: "test",
        course: "delete",
        status: "completed",
        step: "report",
        deletePending: true,
        taskFolder: deleteFolder,
        reportPath: path.join(deleteFolder, "eval_report.pdf")
      }
    ], null, 2));
    launched = await launch();
    runningApp = launched.app;
    const recovered = await launched.page.evaluate(() => window.workbench.readWeeklyTasks());
    const cleanedTask = recovered.find((task) => task.id === "cleanup-pending");
    record(
      "pending finish cleanup is completed after restart",
      cleanedTask?.cleanupPending === false
        && cleanedTask?.taskFolder === ""
        && cleanedTask?.chatLogPath === ""
        && !fs.existsSync(cleanupFolder),
      JSON.stringify(cleanedTask)
    );
    record(
      "pending task deletion is completed after restart",
      !recovered.some((task) => task.id === "delete-pending") && !fs.existsSync(deleteFolder),
      JSON.stringify(recovered)
    );
    await runningApp.close();
    runningApp = null;

    fs.writeFileSync(weeklyTasksPath, JSON.stringify([{
      id: "invariant-rollback",
      school: "test",
      course: "rollback",
      quantity: 1,
      status: "pending",
      subtasks: [{ index: 1, status: "pending" }]
    }], null, 2));
    launched = await launch();
    runningApp = launched.app;
    const invariantRollback = await launched.page.evaluate(async () => {
      let rejected = false;
      try {
        await updateTaskFields("invariant-rollback", { status: "running" });
      } catch {
        rejected = true;
      }
      return {
        rejected,
        status: weeklyTasks.find((task) => task.id === "invariant-rollback")?.status
      };
    });
    record(
      "invalid task updates are rejected by the invariant gate",
      invariantRollback.rejected,
      JSON.stringify(invariantRollback)
    );
    record(
      "rejected task updates roll back the in-memory task",
      invariantRollback.status === "pending",
      JSON.stringify(invariantRollback)
    );
    await runningApp.close();
    runningApp = null;
    record(
      "rejected task updates leave the ledger unchanged",
      JSON.parse(fs.readFileSync(weeklyTasksPath, "utf8"))[0]?.status === "pending"
    );

    fs.writeFileSync(weeklyTasksPath, "{");
    launched = await launch();
    runningApp = launched.app;
    const writeRejected = await launched.page.evaluate(async () => {
      try {
        await window.workbench.writeWeeklyTasks([]);
        return false;
      } catch {
        return true;
      }
    });
    record("corrupt weekly JSON rejects subsequent writes", writeRejected);
    record("corrupt weekly JSON remains untouched", fs.readFileSync(weeklyTasksPath, "utf8") === "{");
  } catch (error) {
    record("task persistence E2E completed", false, String(error?.stack || error));
  } finally {
    if (runningApp) await runningApp.close().catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== Task persistence E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
