// M0/M1：确定性解析器契约测试（task-import-helpers.js）
// 夹具全部为合成数据（示例大学/张三），禁止读取真实 待做任务.txt
const assert = require("node:assert");
const test = require("node:test");

const helpers = require("../task-import-helpers.js");
const {
  parseTodoDocument,
  parseTodoLines,
  toLegacyParseResult,
  validateImportedTask,
  buildTodoImportPreview,
  todoImportKey,
  TODO_IMPORT_LIMITS
} = helpers;

// ===== M0 合成夹具（计划书 §M0 交付原文） =====
const M0_FIXTURE = [
  "示例大学《示例课程》能力训练搭建 5个 未完成 张三 本月完成",
  "示例学院《数据结构》能力训练修改 2个 已完成 李四 周五",
  "示例学校《医学导论》能力训练验收 未提交 王五"
].join("\n");

test("M0: 尾部文本进入备注，不再静默丢弃", () => {
  const doc = parseTodoDocument(M0_FIXTURE);
  assert.equal(doc.version, 1);
  assert.equal(doc.unresolved.length, 0);
  assert.equal(doc.items.length, 3);

  const first = doc.items[0];
  assert.equal(first.task.owner, "张三");
  assert.equal(first.task.note, "本月完成");
  assert.ok(!first.task.owner.includes("搭建"), "任务类型词不得进入负责人");
  // 尾部文本必须有告警痕迹，而不是伪装成完全成功
  assert.ok(first.warnings.some((w) => w.includes("本月完成")));
  assert.equal(first.task.taskType, "capability-setup");
  assert.equal(first.task.quantity, 5);
  assert.equal(first.task.status, "pending");
});

test("M0: 常规行与缺数量行解析正确", () => {
  const doc = parseTodoDocument(M0_FIXTURE);
  const second = doc.items[1];
  assert.equal(second.task.owner, "李四");
  assert.equal(second.task.weekday, "周五");
  assert.equal(second.task.status, "completed");
  assert.deepEqual(second.warnings, []);
  assert.equal(second.confidence, 1);

  const third = doc.items[2];
  assert.equal(third.task.owner, "王五");
  assert.equal(third.task.status, "unsubmitted");
  assert.equal(third.task.quantity, 1);
  assert.equal(third.fieldEvidence.quantity.kind, "default");
});

// ===== 字段来源证据 =====
test("每个字段都有来源证据（source/derived/default）", () => {
  const doc = parseTodoDocument(M0_FIXTURE);
  const fields = ["school", "course", "taskType", "quantity", "status", "weekday", "owner", "note", "subtasks"];
  for (const item of doc.items) {
    for (const field of fields) {
      assert.ok(item.fieldEvidence[field], `${item.task.course} 缺少 ${field} 证据`);
      assert.ok(["source", "derived", "default"].includes(item.fieldEvidence[field].kind));
    }
  }
  assert.equal(doc.items[0].fieldEvidence.owner.kind, "source");
  assert.equal(doc.items[0].fieldEvidence.owner.text, "张三");
  assert.equal(doc.items[0].fieldEvidence.note.kind, "derived");
});

// ===== M1 测试矩阵 =====
test("负责人被任务类型污染：类型词不作为负责人", () => {
  // “能力训练搭” 是打错的类型词（不在枚举中），旧解析器会把它当负责人
  const doc = parseTodoDocument("示例大学《示例课程》能力训练搭 2个 未完成 张三");
  const item = doc.items[0];
  assert.equal(item.task.taskType, "");
  assert.equal(item.task.owner, "张三");
  assert.ok(item.task.note.includes("能力训练搭"), "污染词应进入备注");
  assert.ok(item.warnings.some((w) => w.includes("疑似任务类型词")));
});

test("全角/半角括号子任务备注均可解析", () => {
  const full = parseTodoDocument("示例大学《示例课程》能力训练搭建 4个 未提交（已完成任务1/2，任务3待确认） 张三");
  const half = parseTodoDocument("示例大学《示例课程》能力训练搭建 4个 未提交(已完成任务1/2，任务3待确认) 张三");
  const expected = { 1: "done", 2: "done", 3: "unconfirmed" };
  assert.deepEqual({ ...full.items[0].subtaskMarks }, expected);
  assert.deepEqual({ ...half.items[0].subtaskMarks }, expected);
});

test("任务类型缺失：留空 + 告警 + 置信度下降", () => {
  const doc = parseTodoDocument("示例大学《示例课程》 3个 未完成 张三");
  const item = doc.items[0];
  assert.equal(item.task.taskType, "");
  assert.equal(item.fieldEvidence.taskType.kind, "default");
  assert.ok(item.warnings.some((w) => w.includes("任务类型")));
  assert.ok(item.confidence < 1);
});

test("负责人缺失：owner 为空 + 置信度下降", () => {
  const doc = parseTodoDocument("示例大学《示例课程》能力训练搭建 3个 未完成");
  const item = doc.items[0];
  assert.equal(item.task.owner, "");
  assert.equal(item.fieldEvidence.owner.kind, "default");
  assert.ok(item.confidence < 1);
});

test("多个尾部备注词全部进入备注", () => {
  const doc = parseTodoDocument("示例大学《示例课程》能力训练搭建 3个 未完成 张三 优先处理 下周验收");
  const item = doc.items[0];
  assert.equal(item.task.owner, "张三");
  assert.equal(item.task.note, "优先处理 下周验收");
});

test("数量异常：0 和超上限被修正并告警", () => {
  const zero = parseTodoDocument("示例大学《示例课程》能力训练搭建 0个 未完成 张三").items[0];
  assert.equal(zero.task.quantity, 1);
  assert.ok(zero.warnings.some((w) => w.includes("数量")));

  const huge = parseTodoDocument("示例大学《示例课程》能力训练搭建 5000个 未完成 张三").items[0];
  assert.equal(huge.task.quantity, TODO_IMPORT_LIMITS.quantityMax);
  assert.ok(huge.warnings.some((w) => w.includes("数量")));
});

test("未知状态词不冒充负责人，落入备注", () => {
  const doc = parseTodoDocument("示例大学《示例课程》能力训练搭建 2个 进行中 张三");
  const item = doc.items[0];
  assert.equal(item.task.status, "pending");
  assert.equal(item.task.owner, "张三");
  assert.ok(item.task.note.includes("进行中"));
});

test("无书名号行进入 unresolved 并带原因", () => {
  const doc = parseTodoDocument("这行没有书名号 1个 未完成 张三 周一");
  assert.equal(doc.items.length, 0);
  assert.equal(doc.unresolved.length, 1);
  assert.equal(doc.unresolved[0].sourceLine, 1);
  assert.ok(doc.unresolved[0].reason.includes("书名号"));
});

test("超长学校名被截断并告警（Schema 长度约束）", () => {
  const longSchool = "校".repeat(TODO_IMPORT_LIMITS.school + 10);
  const doc = parseTodoDocument(`${longSchool}《示例课程》能力训练搭建 1个 未完成 张三`);
  const item = doc.items[0];
  assert.equal(item.task.school.length, TODO_IMPORT_LIMITS.school);
  assert.ok(item.warnings.some((w) => w.includes("截断")));
});

test("validateImportedTask 拦截非法枚举与范围", () => {
  const valid = parseTodoDocument(M0_FIXTURE).items[0].task;
  assert.deepEqual(validateImportedTask(valid), []);

  assert.ok(validateImportedTask({ ...valid, taskType: "bad-type" }).some((issue) => issue.includes("任务类型")));
  assert.ok(validateImportedTask({ ...valid, quantity: 0 }).some((issue) => issue.includes("数量")));
  assert.ok(validateImportedTask({ ...valid, status: "weird" }).some((issue) => issue.includes("状态")));
  assert.ok(validateImportedTask({ ...valid, school: "" }).some((issue) => issue.includes("学校")));
  assert.ok(validateImportedTask({ ...valid, weekday: "周八" }).some((issue) => issue.includes("星期")));
});

// ===== 旧契约兼容 =====
test("toLegacyParseResult 保持旧 9 字段形状", () => {
  const legacy = parseTodoLines(M0_FIXTURE);
  assert.equal(legacy.tasks.length, 3);
  assert.equal(legacy.unparsed.length, 0);
  assert.deepEqual(
    Object.keys(legacy.tasks[0]).sort(),
    ["course", "note", "owner", "quantity", "school", "status", "subtaskMarks", "taskType", "weekday"]
  );
  assert.equal(toLegacyParseResult(parseTodoDocument("没有书名号的行")).unparsed[0], "没有书名号的行");
});

// ===== 差异分类 =====
test("同一稳定键对应多个现有任务：记入 duplicateKeys 且行为确定（后者覆盖）", () => {
  const incoming = parseTodoLines("示例大学《示例课程》能力训练搭建 2个 未完成 张三").tasks;
  const existing = [
    { id: "task-a", school: "示例大学", course: "示例课程", taskType: "capability-setup", quantity: 2, status: "pending", owner: "张三", weekday: "", note: "", subtasks: [] },
    { id: "task-b", school: "示例大学", course: "示例课程", taskType: "capability-setup", quantity: 3, status: "pending", owner: "李四", weekday: "", note: "", subtasks: [] }
  ];
  const groups = buildTodoImportPreview(incoming, [], existing, (task) => task);
  assert.deepEqual(groups.duplicateKeys, [todoImportKey(existing[0])]);
  // Map 行为：与后一个现有任务比较（确定性），差异进入 updated
  assert.equal(groups.updated.length, 1);
  assert.equal(groups.updated[0].existingId, "task-b");
});

test("差异分类：新增/更新/未变化分组正确", () => {
  const incoming = parseTodoLines([
    "示例大学《示例课程》能力训练搭建 2个 未完成 张三",
    "示例学院《数据结构》能力训练修改 1个 未完成 李四"
  ].join("\n")).tasks;
  const existing = [
    { id: "task-1", school: "示例大学", course: "示例课程", taskType: "capability-setup", quantity: 2, status: "pending", owner: "张三", weekday: "", note: "", subtasks: [{ index: 1, status: "pending" }, { index: 2, status: "pending" }] }
  ];
  const groups = buildTodoImportPreview(incoming, ["坏行"], existing, (task) => task);
  assert.equal(groups.unchanged.length, 1);
  assert.equal(groups.added.length, 1);
  assert.equal(groups.added[0].task.course, "数据结构");
  assert.deepEqual(groups.unparsed, ["坏行"]);
  assert.deepEqual(groups.duplicateKeys, []);
});
