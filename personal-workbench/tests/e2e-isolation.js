const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function isolateWeeklyTasks(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `personal-workbench-${label}-`));
  const weeklyTasksPath = path.join(root, "weekly_tasks.json");
  const userDataDir = path.join(root, "user-data");
  const downloadRoot = path.join(root, "downloads-root");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(downloadRoot, { recursive: true });
  fs.writeFileSync(weeklyTasksPath, "[]", "utf8");
  process.env.PERSONAL_WORKBENCH_WEEKLY_TASKS_PATH = weeklyTasksPath;
  process.env.PERSONAL_WORKBENCH_USER_DATA = userDataDir;
  process.env.PERSONAL_WORKBENCH_DOWNLOAD_ROOT = downloadRoot;
  process.once("exit", () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });
  return weeklyTasksPath;
}

module.exports = { isolateWeeklyTasks };
