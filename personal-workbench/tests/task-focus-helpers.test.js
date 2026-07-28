const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing block start: ${startMarker}`);
  assert.notEqual(end, -1, `missing block end: ${endMarker}`);
  return source.slice(start, end + endMarker.length);
}

function loadTaskFocusHelpers() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const source = fs.readFileSync(rendererPath, "utf8");
  const filterBlock = sourceBlock(
    source,
    "function taskTypeLabel(type) {",
    "window.findPotentialTaskDuplicateGroups = findPotentialTaskDuplicateGroups;"
  );
  const laneBlock = sourceBlock(
    source,
    "// ============ 任务时限 / 分区 / 跨周清理（纯函数，供测试注入） ============",
    "window.isoWeekKeyFromDate = isoWeekKeyFromDate;"
  );
  const sandbox = {
    window: {},
    console,
    String,
    Number,
    Array,
    Object,
    Boolean,
    Math,
    Date,
    Set,
    Map
  };
  vm.runInNewContext(`${filterBlock}\n${laneBlock}`, sandbox, { filename: rendererPath });
  return sandbox.window;
}

const helpers = loadTaskFocusHelpers();

test("focus view keeps urgent work and fills remaining slots by due date", () => {
  const tasks = [
    { id: "routine-later", status: "pending", dueDate: "2026-08-10" },
    { id: "soon", status: "pending", dueDate: "2026-07-30" },
    { id: "overdue", status: "pending", dueDate: "2026-07-27" },
    { id: "unsubmitted", status: "unsubmitted", dueDate: "2026-08-12" },
    { id: "paused", status: "paused", dueDate: "2026-08-11" },
    { id: "running", status: "running", dueDate: "2026-08-15" },
    { id: "routine-near", status: "pending", dueDate: "2026-08-01" },
    { id: "done", status: "completed", dueDate: "2026-07-20" },
    { id: "archived", status: "pending", dueDate: "2026-07-20", archived: true }
  ];
  const selected = helpers.selectFocusTasks(tasks, { todayYmd: "2026-07-28", limit: 6 });
  assert.deepEqual(
    Array.from(selected, (task) => task.id),
    ["running", "paused", "unsubmitted", "overdue", "soon", "routine-near"]
  );
});

test("focus view never drops urgent tasks merely to satisfy its soft limit", () => {
  const urgent = Array.from({ length: 8 }, (_item, index) => ({
    id: `overdue-${index}`,
    status: "pending",
    dueDate: `2026-07-${String(20 + index).padStart(2, "0")}`
  }));
  const selected = helpers.selectFocusTasks(urgent, { todayYmd: "2026-07-28", limit: 3 });
  assert.equal(selected.length, 8);
});

test("duplicate warnings require the same school, course, and task type", () => {
  const groups = helpers.findPotentialTaskDuplicateGroups([
    { id: "a", school: "示例大学", course: "算法", taskType: "capability-setup" },
    { id: "b", school: " 示例大学 ", course: "算法", taskType: "CAPABILITY-SETUP" },
    { id: "c", school: "示例大学", course: "算法", taskType: "grading-setup" },
    { id: "d", school: "示例大学", course: "算法", taskType: "capability-setup", archived: true },
    { id: "e", school: "", course: "算法", taskType: "capability-setup" }
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(Array.from(groups[0], (task) => task.id), ["a", "b"]);
});
