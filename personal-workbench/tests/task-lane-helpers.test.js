const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadTaskLaneHelpers() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const source = fs.readFileSync(rendererPath, "utf8");
  const start = source.indexOf("// ============ 任务时限 / 分区 / 跨周清理（纯函数，供测试注入） ============");
  const endMarker = "window.isoWeekKeyFromDate = isoWeekKeyFromDate;";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, "task lane helpers block missing");
  assert.notEqual(end, -1, "task lane helpers export missing");
  const block = source.slice(start, end + endMarker.length);
  const sandbox = {
    window: {},
    console,
    String,
    Number,
    Array,
    Object,
    Boolean,
    Math,
    Date
  };
  vm.runInNewContext(block, sandbox, { filename: rendererPath });
  return sandbox.window;
}

const helpers = loadTaskLaneHelpers();

test("defaultDueDateForWeek returns Sunday of current ISO week", () => {
  // 2026-07-15 is Wednesday → Sunday 2026-07-19
  assert.equal(helpers.defaultDueDateForWeek(new Date(2026, 6, 15)), "2026-07-19");
  // Sunday stays itself
  assert.equal(helpers.defaultDueDateForWeek(new Date(2026, 6, 19)), "2026-07-19");
  // Monday → that week's Sunday
  assert.equal(helpers.defaultDueDateForWeek(new Date(2026, 6, 13)), "2026-07-19");
});

test("normalizeDueDate accepts valid ymd and falls back to week Sunday", () => {
  assert.equal(helpers.normalizeDueDate("2026-07-20"), "2026-07-20");
  assert.equal(helpers.normalizeDueDate(""), helpers.defaultDueDateForWeek());
  assert.equal(helpers.normalizeDueDate("bad", new Date(2026, 6, 15)), "2026-07-19");
});

test("laneStatusForDrop maps lanes to statuses", () => {
  assert.equal(helpers.laneStatusForDrop("active"), "pending");
  assert.equal(helpers.laneStatusForDrop("unsubmitted"), "unsubmitted");
  assert.equal(helpers.laneStatusForDrop("done"), "completed");
  assert.equal(helpers.taskLaneForStatus("paused"), "active");
  assert.equal(helpers.taskLaneForStatus("running"), "active");
  assert.equal(helpers.taskLaneForStatus("unsubmitted"), "unsubmitted");
  assert.equal(helpers.taskLaneForStatus("completed"), "done");
});

test("same-lane drop preserves the task's active status", () => {
  assert.equal(helpers.taskStatusForDrop({ status: "running" }, "active"), "running");
  assert.equal(helpers.taskStatusForDrop({ status: "paused" }, "active"), "paused");
  assert.equal(helpers.taskStatusForDrop({ status: "evaluating" }, "active"), "evaluating");
  assert.equal(helpers.taskStatusForDrop({ status: "pending" }, "done"), "completed");
});

test("sortTasksForLane orders by dueDate then sortKey then school/course", () => {
  const sorted = helpers.sortTasksForLane([
    { id: "c", dueDate: "2026-07-20", sortKey: 0, school: "B", course: "1" },
    { id: "a", dueDate: "2026-07-18", sortKey: 2, school: "A", course: "1" },
    { id: "b", dueDate: "2026-07-18", sortKey: 1, school: "A", course: "2" }
  ]);
  assert.deepEqual(Array.from(sorted.map((task) => String(task.id))), ["b", "a", "c"]);
});

test("shouldPurgeCompletedTask only removes older completed weeks", () => {
  const current = helpers.isoWeekKeyFromDate(new Date(2026, 6, 15)); // 2026-07-15 local
  const older = new Date(2026, 6, 5, 12, 0, 0).toISOString(); // previous week
  const sameWeek = new Date(2026, 6, 15, 12, 0, 0).toISOString();
  assert.equal(helpers.shouldPurgeCompletedTask({
    status: "completed",
    completedAt: older
  }, current), true);
  assert.equal(helpers.shouldPurgeCompletedTask({
    status: "completed",
    completedAt: sameWeek
  }, current), false);
  assert.equal(helpers.shouldPurgeCompletedTask({
    status: "pending",
    completedAt: older
  }, current), false);
  assert.equal(helpers.shouldPurgeCompletedTask({
    status: "completed"
  }, current), false);
});

test("purgeCompletedFromPreviousWeeks keeps unfinished and current-week completed", () => {
  const current = helpers.isoWeekKeyFromDate(new Date(2026, 6, 15));
  const older = new Date(2026, 6, 5, 12, 0, 0).toISOString();
  const sameWeek = new Date(2026, 6, 15, 12, 0, 0).toISOString();
  const result = helpers.purgeCompletedFromPreviousWeeks([
    { id: "old", status: "completed", completedAt: older },
    { id: "cur", status: "completed", completedAt: sameWeek },
    { id: "open", status: "pending", dueDate: "2026-07-01" }
  ], current);
  // vm 沙箱 Array 与宿主 Array 不能 deepStrictEqual，转成宿主数组再比
  assert.deepEqual(Array.from(result.removed.map((task) => String(task.id))), ["old"]);
  assert.deepEqual(Array.from(result.kept.map((task) => String(task.id))), ["cur", "open"]);
});

test("isTaskDueOverdue ignores completed tasks", () => {
  assert.equal(helpers.isTaskDueOverdue({ status: "pending", dueDate: "2026-07-01" }, "2026-07-17"), true);
  assert.equal(helpers.isTaskDueOverdue({ status: "completed", dueDate: "2026-07-01" }, "2026-07-17"), false);
  assert.equal(helpers.isTaskDueOverdue({ status: "pending", dueDate: "2026-07-20" }, "2026-07-17"), false);
});
