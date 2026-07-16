const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadTaskFilterHelpers() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const source = fs.readFileSync(rendererPath, "utf8");

  const start = source.indexOf("function taskTypeLabel(type) {");
  const endMarker = "window.taskTypeLabel = taskTypeLabel;";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, "renderer.js should contain taskTypeLabel");
  assert.notEqual(end, -1, "renderer.js should expose task filter helpers on window");

  const sliceEnd = end + endMarker.length;
  const block = source.slice(start, sliceEnd);

  const sandbox = {
    window: {},
    console,
    String,
    Number,
    Array,
    Object,
    Boolean,
    Math
  };
  vm.runInNewContext(block, sandbox, { filename: rendererPath });
  return sandbox.window;
}

const helpers = loadTaskFilterHelpers();

const sampleTasks = [
  {
    id: "a",
    school: "医学部",
    course: "解剖学",
    owner: "张三",
    note: "优先处理",
    taskType: "capability-setup",
    status: "pending",
    archived: false
  },
  {
    id: "b",
    school: "工学部",
    course: "材料力学",
    owner: "李四",
    note: "",
    taskType: "grading-edit",
    status: "paused",
    archived: false
  },
  {
    id: "c",
    school: "医学部",
    course: "药理学",
    owner: "王五",
    note: "复测",
    taskType: "capability-acceptance",
    status: "completed",
    archived: true
  },
  {
    id: "d",
    school: "文学部",
    course: "写作",
    owner: "赵六",
    note: "评估中",
    taskType: "capability-setup",
    status: "running",
    archived: false
  },
  {
    id: "e",
    school: "工学部",
    course: "电路",
    owner: "钱七",
    note: "",
    taskType: "grading-setup",
    status: "evaluating",
    archived: false
  }
];

test("matchesTaskQuery returns true for empty query", () => {
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], ""), true);
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], "   "), true);
});

test("matchesTaskQuery matches school course owner note and type label", () => {
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], "医学"), true);
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], "解剖"), true);
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], "张三"), true);
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], "优先"), true);
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], "能力训练搭建"), true);
  assert.equal(helpers.matchesTaskQuery(sampleTasks[0], "材料"), false);
});

test("matchesTaskQuery is case-insensitive", () => {
  const task = { ...sampleTasks[0], school: "Medical School", course: "Anatomy" };
  assert.equal(helpers.matchesTaskQuery(task, "medical"), true);
  assert.equal(helpers.matchesTaskQuery(task, "ANATOMY"), true);
});

test("filterTasks hides archived by default", () => {
  const visible = helpers.filterTasks(sampleTasks, { query: "", status: "all", school: "" });
  assert.deepEqual(visible.map((task) => task.id), ["a", "b", "d", "e"]);
});

test("filterTasks shows only archived when status is archived", () => {
  const visible = helpers.filterTasks(sampleTasks, { status: "archived" });
  assert.deepEqual(visible.map((task) => task.id), ["c"]);
});

test("filterTasks status chips match expected statuses", () => {
  assert.deepEqual(
    helpers.filterTasks(sampleTasks, { status: "pending" }).map((task) => task.id),
    ["a"]
  );
  assert.deepEqual(
    helpers.filterTasks(sampleTasks, { status: "paused" }).map((task) => task.id),
    ["b"]
  );
  assert.deepEqual(
    helpers.filterTasks(sampleTasks, { status: "running" }).map((task) => task.id),
    ["d", "e"]
  );
  assert.deepEqual(
    helpers.filterTasks(sampleTasks, { status: "completed" }).map((task) => task.id),
    []
  );
});

test("filterTasks school filter is exact match on school field", () => {
  const visible = helpers.filterTasks(sampleTasks, { school: "医学部" });
  assert.deepEqual(visible.map((task) => task.id), ["a"]);
});

test("filterTasks combines query status and school", () => {
  const visible = helpers.filterTasks(sampleTasks, {
    query: "医学",
    status: "pending",
    school: "医学部"
  });
  assert.deepEqual(visible.map((task) => task.id), ["a"]);
});

test("taskTypeLabel covers known task types", () => {
  assert.equal(helpers.taskTypeLabel("capability-setup"), "能力训练搭建");
  assert.equal(helpers.taskTypeLabel("grading-edit"), "作业批阅修改");
  assert.equal(helpers.taskTypeLabel("unknown"), "unknown");
});
