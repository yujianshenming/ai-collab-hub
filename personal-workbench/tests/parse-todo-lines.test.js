const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadParseTodoLines() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const rendererSource = fs.readFileSync(rendererPath, "utf8");
  const start = rendererSource.indexOf("const TODO_TYPE_MAP = [");
  const endMarker = "window.parseTodoLines = parseTodoLines;";
  const end = rendererSource.indexOf(endMarker, start);

  assert.notEqual(start, -1, "renderer.js should contain todo parsing block");
  assert.notEqual(end, -1, "renderer.js should expose parseTodoLines on window");

  const sandbox = { window: {} };
  vm.runInNewContext(
    rendererSource.slice(start, end + endMarker.length),
    sandbox,
    { filename: rendererPath }
  );
  return sandbox.window.parseTodoLines;
}

const parseTodoLines = loadParseTodoLines();

const SPEC_SAMPLE = [
  "河南职业技术学院《工程机器人现场编程》 8个 已完成 李姝琦 周二",
  "西安理工大学《生物医用材料》 能力训练搭建 5个 未提交（已完成任务3/4/5/6，任务2待确认） 赵俞蓉 周三",
  "首都医科大学《生物医学工程项目管理》能力训练搭建 2个 已完成 赵俞蓉 周三",
  "安徽中医药大学《经络腧穴学》能力训练搭建 2个 未完成 李漫1 周四",
  "佳木斯大学《医学遗传学》能力训练修改 8个 已完成  姜唯一",
  "南昌航空大学《电路分析》能力训练搭建 1个 未完成 姜唯一",
  "南开大学《改变世界的化学》能力训练修改 1个 未完成 李安琪",
  "佳木斯大学《学校体育学》作业批阅修改"
].join("\n");

function byCourse(tasks, course) {
  return tasks.find((task) => task.course === course);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("parses all 8 real examples from spec section 0", () => {
  const result = parseTodoLines(SPEC_SAMPLE);

  assert.equal(result.unparsed.length, 0);
  assert.equal(result.tasks.length, 8);

  assert.deepEqual(plain(byCourse(result.tasks, "工程机器人现场编程")), {
    school: "河南职业技术学院",
    course: "工程机器人现场编程",
    taskType: "",
    quantity: 8,
    status: "completed",
    owner: "李姝琦",
    weekday: "周二",
    note: "",
    subtaskMarks: null
  });

  assert.deepEqual(plain(byCourse(result.tasks, "生物医学工程项目管理")), {
    school: "首都医科大学",
    course: "生物医学工程项目管理",
    taskType: "capability-setup",
    quantity: 2,
    status: "completed",
    owner: "赵俞蓉",
    weekday: "周三",
    note: "",
    subtaskMarks: null
  });

  assert.deepEqual(plain(byCourse(result.tasks, "学校体育学")), {
    school: "佳木斯大学",
    course: "学校体育学",
    taskType: "grading-edit",
    quantity: 1,
    status: "pending",
    owner: "",
    weekday: "",
    note: "",
    subtaskMarks: null
  });
});

test("puts lines without Chinese book title brackets into unparsed", () => {
  const result = parseTodoLines("这行没有书名号 1个 未完成 张三 周一");

  assert.deepEqual(plain(result.tasks), []);
  assert.deepEqual(plain(result.unparsed), ["这行没有书名号 1个 未完成 张三 周一"]);
});

test("handles double spaces, missing type, and owner with digit", () => {
  const result = parseTodoLines([
    "佳木斯大学《医学遗传学》能力训练修改 8个 已完成  姜唯一",
    "河南职业技术学院《工程机器人现场编程》 8个 已完成 李姝琦 周二",
    "安徽中医药大学《经络腧穴学》能力训练搭建 2个 未完成 李漫1 周四"
  ].join("\n"));

  assert.equal(byCourse(result.tasks, "医学遗传学").owner, "姜唯一");

  const missingType = byCourse(result.tasks, "工程机器人现场编程");
  assert.equal(missingType.taskType, "");
  assert.equal(missingType.quantity, 8);
  assert.equal(missingType.status, "completed");

  const digitOwner = byCourse(result.tasks, "经络腧穴学");
  assert.equal(digitOwner.owner, "李漫1");
  assert.equal(digitOwner.weekday, "周四");
});

test("parses unsubmitted subtask note with done and unconfirmed tasks", () => {
  const result = parseTodoLines(
    "西安理工大学《生物医用材料》 能力训练搭建 5个 未提交（已完成任务3/4/5/6，任务2待确认） 赵俞蓉 周三"
  );

  assert.equal(result.unparsed.length, 0);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(plain(result.tasks[0]), {
    school: "西安理工大学",
    course: "生物医用材料",
    taskType: "capability-setup",
    quantity: 5,
    status: "unsubmitted",
    owner: "赵俞蓉",
    weekday: "周三",
    note: "",
    subtaskMarks: {
      2: "unconfirmed",
      3: "done",
      4: "done",
      5: "done",
      6: "done"
    }
  });
}
);
