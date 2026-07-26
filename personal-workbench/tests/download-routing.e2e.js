const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
isolateWeeklyTasks("download-e2e");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const userDataDir = process.env.PERSONAL_WORKBENCH_USER_DATA;
const downloadDir = path.join(userDataDir, "Downloads");
const tasksRoot = path.resolve(process.env.PERSONAL_WORKBENCH_DOWNLOAD_ROOT, "tasks");
fs.mkdirSync(downloadDir, { recursive: true });

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForDownloadEvent(page, filename, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await page.evaluate((targetName) => (
      window.__downloadEvents.find((item) => item.filename === targetName) || null
    ), filename);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForToastMessage(page, filename, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate((targetName) => (
      window.__toastMessages.find((item) => item.includes(targetName)) || ""
    ), filename);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "";
}

async function removeTempTree(targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (!resolvedTarget.startsWith(`${resolvedTemp}${path.sep}`)) {
    throw new Error(`Refusing to remove non-temp path: ${resolvedTarget}`);
  }
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(resolvedTarget, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

function triggerDownload(app, url) {
  return app.evaluate(async ({ BrowserWindow }, targetUrl) => {
    const win = new BrowserWindow({
      show: false,
      title: "download-routing-e2e",
      webPreferences: { partition: "persist:personal-workbench" }
    });
    await win.loadURL("about:blank");
    win.webContents.downloadURL(targetUrl);
  }, url);
}

function closeDownloadWindows(app) {
  return app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.getTitle() === "download-routing-e2e") win.destroy();
    }
  });
}

(async () => {
  let app;
  let server;
  let taskFolder = "";
  try {
    server = http.createServer((req, res) => {
      const active = req.url.includes("active");
      const filename = active ? "active-task.txt" : "no-task.txt";
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`
      });
      res.end(active ? "active task download" : "ordinary download");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    app = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${userDataDir}`],
      cwd: root
    });
    await app.evaluate(({ app: electronApp }, targetDir) => {
      electronApp.setPath("downloads", targetDir);
    }, downloadDir);

    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      window.__downloadEvents = [];
      window.__toastMessages = [];
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && node.matches?.(".toast-message")) {
              window.__toastMessages.push(node.textContent || "");
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      window.workbench.onDownloadCompleted((event) => window.__downloadEvents.push(event));
      window.workbench.updateActiveTaskInfo({ folderPath: "" });
    });

    const ordinaryPath = path.join(downloadDir, "no-task.txt");
    await triggerDownload(app, `http://127.0.0.1:${port}/download`);
    record("no-task download reaches the system Downloads directory", await waitForFile(ordinaryPath), ordinaryPath);

    const ordinaryPayload = await waitForDownloadEvent(page, "no-task.txt");
    record(
      "no-task completion remains generic and visible to the renderer",
      ordinaryPayload?.type === "generic" && ordinaryPayload?.captured === false && ordinaryPayload?.path === ordinaryPath,
      JSON.stringify(ordinaryPayload)
    );
    const ordinaryToast = await waitForToastMessage(page, "no-task.txt");
    record("no-task toast names the system Downloads directory", ordinaryToast.includes("系统下载文件夹"), ordinaryToast);
    await closeDownloadWindows(app);

    const collisionPath = path.join(downloadDir, "no-task (2).txt");
    await triggerDownload(app, `http://127.0.0.1:${port}/download`);
    record("download name collisions receive a distinct saved path", await waitForFile(collisionPath), collisionPath);
    const collisionPayload = await waitForDownloadEvent(page, "no-task (2).txt");
    record(
      "download feedback uses the actual saved filename",
      collisionPayload?.path === collisionPath && collisionPayload?.filename === path.basename(collisionPath),
      JSON.stringify(collisionPayload)
    );
    await closeDownloadWindows(app);

    taskFolder = await page.evaluate(() => window.workbench.prepareTaskFolder({
      id: "download-routing-e2e",
      school: "test",
      course: "download"
    }));
    const activePath = path.join(taskFolder, "active-task.txt");
    await triggerDownload(app, `http://127.0.0.1:${port}/download?active=1`);
    record("active-task download still reaches the task folder", await waitForFile(activePath), activePath);

    const activePayload = await waitForDownloadEvent(page, "active-task.txt");
    record(
      "active-task completion remains captured",
      activePayload?.captured === true && activePayload?.path === activePath,
      JSON.stringify(activePayload)
    );
    const capturedToast = await waitForToastMessage(page, "active-task.txt");
    record(
      "captured download toast follows event destination even when renderer task state is idle",
      capturedToast.includes("任务文件夹") && !capturedToast.includes("系统下载文件夹"),
      capturedToast
    );

    const lateDownloadRouting = await page.evaluate(async () => {
      weeklyTasks = [
        normalizeWeeklyTask({ id: "task-a", school: "A", course: "A", status: "paused" }),
        normalizeWeeklyTask({
          id: "task-b",
          school: "B",
          course: "B",
          status: "running",
          subtasks: [{ index: 1, status: "running" }]
        })
      ];
      pipelineState = {
        active: true,
        taskId: "task-b",
        step: "testing",
        chatPath: "",
        reportPath: "",
        taskFolder: "B-folder",
        uploadQueue: []
      };
      updateTaskFields = async (id, fields) => {
        const target = weeklyTasks.find((task) => task.id === id);
        Object.assign(target, fields);
        return target;
      };
      await handleDownloadCompleted({
        state: "completed",
        type: "chat",
        taskId: "task-a",
        captured: true,
        path: "A-folder/dialogue.json",
        filename: "dialogue.json"
      });
      await handleDownloadCompleted({
        state: "completed",
        type: "report",
        taskId: "task-a",
        captured: true,
        path: "A-folder/eval_report.pdf",
        filename: "eval_report.pdf"
      });
      return {
        taskA: weeklyTasks.find((task) => task.id === "task-a"),
        taskB: weeklyTasks.find((task) => task.id === "task-b"),
        activeTaskId: pipelineState.taskId,
        activeStep: pipelineState.step
      };
    });
    record(
      "late task-A download cannot advance active task B",
      lateDownloadRouting.taskA.chatLogPath.endsWith("dialogue.json")
        && lateDownloadRouting.taskA.reportPath.endsWith("eval_report.pdf")
        && lateDownloadRouting.taskA.step === "report"
        && lateDownloadRouting.taskA.status === "paused"
        && lateDownloadRouting.taskB.step === "testing"
        && lateDownloadRouting.taskB.chatLogPath === ""
        && lateDownloadRouting.activeTaskId === "task-b"
        && lateDownloadRouting.activeStep === "testing",
      JSON.stringify(lateDownloadRouting)
    );

    const duplicateDownloadRouting = await page.evaluate(async () => {
      weeklyTasks = [normalizeWeeklyTask({
        id: "task-current",
        school: "Current",
        course: "Current",
        status: "completed",
        subtasks: [{ index: 1, status: "done" }],
        step: "report",
        reportPath: "task-current/eval_report.pdf"
      })];
      pipelineState = {
        active: true,
        taskId: "task-current",
        step: "report",
        chatPath: "task-current/dialogue.json",
        reportPath: "task-current/eval_report.pdf",
        taskFolder: "task-current",
        uploadQueue: []
      };
      await handleDownloadCompleted({
        state: "completed",
        type: "chat",
        taskId: "task-current",
        taskStep: "testing",
        captured: true,
        path: "task-current/dialogue (2).json",
        filename: "dialogue (2).json"
      });
      return {
        task: weeklyTasks[0],
        activeStep: pipelineState.step,
        reportPath: pipelineState.reportPath
      };
    });
    record(
      "duplicate late chat download cannot regress a completed task",
      duplicateDownloadRouting.task.step === "report"
        && duplicateDownloadRouting.task.status === "completed"
        && duplicateDownloadRouting.activeStep === "report"
        && duplicateDownloadRouting.reportPath.endsWith("eval_report.pdf"),
      JSON.stringify(duplicateDownloadRouting)
    );
    await closeDownloadWindows(app);

    record("task fixture cleanup succeeds", await page.evaluate((folder) => window.workbench.cleanupTaskFolder(folder), taskFolder));
    taskFolder = "";
  } catch (error) {
    record("download routing E2E completed", false, String(error?.stack || error));
  } finally {
    if (app) {
      await closeDownloadWindows(app).catch(() => {});
      await app.close().catch(() => {});
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (taskFolder) {
      const resolved = path.resolve(taskFolder);
      if (resolved.startsWith(`${tasksRoot}${path.sep}`)) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
    await removeTempTree(userDataDir);
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== Download routing E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
