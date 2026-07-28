// ============ 待做任务导入纯逻辑（M1 自 renderer.js 抽取） ============
// 职责：确定性解析（parseTodoDocument）、字段来源证据、Schema 校验、差异分类。
// 双端加载：Node 测试走 module.exports；渲染进程在 index.html 中先于 renderer.js
// 以普通 <script> 加载，挂到 window.TaskImportHelpers（并保留 window.parseTodoLines 兼容入口）。
// 本模块禁止任何 DOM / IPC / 网络依赖。
"use strict";

(() => {
  const TODO_TYPE_MAP = [
    ["能力训练搭建", "capability-setup"],
    ["能力训练修改", "capability-edit"],
    ["能力训练验收", "capability-acceptance"],
    ["作业批阅搭建", "grading-setup"],
    ["作业批阅验收", "grading-acceptance"],
    ["作业批阅修改", "grading-edit"]
  ];
  const TODO_TYPE_VALUES = TODO_TYPE_MAP.map(([, value]) => value);
  const TODO_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const TODO_IMPORT_FIELDS = ["quantity", "status", "owner", "weekday", "subtasks", "note"];
  const TODO_IMPORT_FIELD_LABELS = {
    quantity: "数量",
    status: "状态",
    owner: "负责人",
    weekday: "星期",
    subtasks: "子任务",
    note: "备注"
  };
  // Schema 长度/范围约束（计划书 §5.1）
  const TODO_IMPORT_LIMITS = {
    school: 120,
    course: 160,
    owner: 80,
    note: 1000,
    quantityMin: 1,
    quantityMax: 999
  };
  // 负责人候选词里出现这些片段时判定为“任务类型词污染”，不得作为负责人
  const TYPE_FRAGMENTS = ["能力训练", "作业批阅", "搭建", "修改", "验收", "批阅"];
  // 状态类词片段：出现在剩余文本中说明是状态/进度描述，进备注而非负责人
  const STATUS_FRAGMENTS = ["已完成", "未完成", "未提交", "进行中", "已暂停", "待确认", "完成", "提交"];

  // 括号备注 → 子任务标记：{ 编号: "done"|"unconfirmed" }；无法识别返回 null
  function parseSubtaskNote(text) {
    const marks = {};
    let matched = false;
    const splitNums = (raw) => raw.split(/[/、,，\s]+/).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
    const doneMatch = text.match(/已完成任务([\d/、,，\s]+)/) || text.match(/任务([\d/、,，\s]+)已完成/);
    if (doneMatch) {
      for (const n of splitNums(doneMatch[1])) marks[n] = "done";
      matched = true;
    }
    const unconfirmedMatch = text.match(/任务([\d/、,，\s]+)待确认/) || text.match(/待确认任务([\d/、,，\s]+)/);
    if (unconfirmedMatch) {
      for (const n of splitNums(unconfirmedMatch[1])) marks[n] = "unconfirmed";
      matched = true;
    }
    return matched ? marks : null;
  }

  function clampText(value, limit) {
    const text = String(value || "").trim();
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function looksLikeOwner(token) {
    if (!token || token.length > TODO_IMPORT_LIMITS.owner) return false;
    if (TYPE_FRAGMENTS.some((fragment) => token.includes(fragment))) return false;
    if (STATUS_FRAGMENTS.some((fragment) => token.includes(fragment))) return false;
    return true;
  }

  // 单行解析 → 契约 item：字段按明确语义顺序消费（学校课程 → 类型 → 数量 → 状态 → 星期 → 负责人 → 剩余进备注）
  // 每个字段附带来源证据 {kind: "source"|"derived"|"default", text}
  function parseTodoLineItem(line, sourceLine) {
    const warnings = [];
    const fieldEvidence = {};
    let confidence = 1;

    const head = line.match(/^(.+?)《([^》]+)》(.*)$/);
    if (!head) return null;

    let school = clampText(head[1], TODO_IMPORT_LIMITS.school);
    if (head[1].trim().length > TODO_IMPORT_LIMITS.school) {
      warnings.push(`学校名超过 ${TODO_IMPORT_LIMITS.school} 字，已截断`);
      confidence -= 0.1;
    }
    let course = clampText(head[2], TODO_IMPORT_LIMITS.course);
    if (head[2].trim().length > TODO_IMPORT_LIMITS.course) {
      warnings.push(`课程名超过 ${TODO_IMPORT_LIMITS.course} 字，已截断`);
      confidence -= 0.1;
    }
    fieldEvidence.school = { kind: "source", text: head[1].trim() };
    fieldEvidence.course = { kind: "source", text: head[2].trim() };
    let rest = head[3];

    let taskType = "";
    for (const [keyword, value] of TODO_TYPE_MAP) {
      if (rest.includes(keyword)) {
        taskType = value;
        fieldEvidence.taskType = { kind: "source", text: keyword };
        rest = rest.replace(keyword, " ");
        break;
      }
    }
    if (!taskType) {
      fieldEvidence.taskType = { kind: "default", text: "" };
      warnings.push("未匹配到已知任务类型");
      confidence -= 0.2;
    }

    let quantity = 1;
    const quantityMatch = rest.match(/(\d+)个/);
    if (quantityMatch) {
      const rawQuantity = Number(quantityMatch[1]);
      quantity = Math.min(TODO_IMPORT_LIMITS.quantityMax, Math.max(TODO_IMPORT_LIMITS.quantityMin, rawQuantity));
      fieldEvidence.quantity = { kind: "source", text: quantityMatch[0] };
      if (quantity !== rawQuantity) {
        warnings.push(`数量 ${rawQuantity} 超出 ${TODO_IMPORT_LIMITS.quantityMin}-${TODO_IMPORT_LIMITS.quantityMax}，已修正为 ${quantity}`);
        confidence -= 0.1;
      }
      rest = rest.replace(quantityMatch[0], " ");
    } else {
      fieldEvidence.quantity = { kind: "default", text: "1" };
    }

    let status = "pending";
    let parenNote = "";
    let subtaskMarks = null;
    const statusMatch = rest.match(/(已完成|未完成|未提交)\s*(（[^）]*）|\([^)]*\))?/);
    if (statusMatch) {
      status = statusMatch[1] === "已完成" ? "completed" : statusMatch[1] === "未提交" ? "unsubmitted" : "pending";
      fieldEvidence.status = { kind: "source", text: statusMatch[1] };
      if (statusMatch[2]) {
        const inner = statusMatch[2].slice(1, -1).trim();
        subtaskMarks = parseSubtaskNote(inner);
        if (subtaskMarks) fieldEvidence.subtasks = { kind: "source", text: inner };
        else parenNote = inner;
      }
      rest = rest.replace(statusMatch[0], " ");
    } else {
      fieldEvidence.status = { kind: "default", text: "未完成" };
    }
    if (!fieldEvidence.subtasks) fieldEvidence.subtasks = { kind: "default", text: "按数量与状态推导" };

    let weekday = "";
    const weekdayMatch = rest.match(/周[一二三四五六日]/);
    if (weekdayMatch) {
      weekday = weekdayMatch[0];
      fieldEvidence.weekday = { kind: "source", text: weekdayMatch[0] };
      rest = rest.replace(weekdayMatch[0], " ");
    } else {
      fieldEvidence.weekday = { kind: "default", text: "" };
    }

    // 负责人：取第一个“像人名”的 token；类型词/状态词污染的 token 一律进备注并告警
    let owner = "";
    const tailTokens = [];
    for (const token of rest.trim().split(/\s+/).filter(Boolean)) {
      if (!owner && looksLikeOwner(token)) {
        owner = token;
        fieldEvidence.owner = { kind: "source", text: token };
        continue;
      }
      if (!owner && TYPE_FRAGMENTS.some((fragment) => token.includes(fragment))) {
        warnings.push(`「${token}」疑似任务类型词，未作为负责人`);
        confidence -= 0.15;
      }
      tailTokens.push(token);
    }
    if (!owner) {
      fieldEvidence.owner = { kind: "default", text: "" };
      confidence -= 0.1;
    }

    // 所有剩余文本进入备注，绝不静默丢弃
    const tailText = tailTokens.join(" ");
    const rawNote = [parenNote, tailText].filter(Boolean).join(" ");
    const note = clampText(rawNote, TODO_IMPORT_LIMITS.note);
    if (rawNote.length > TODO_IMPORT_LIMITS.note) warnings.push(`备注超过 ${TODO_IMPORT_LIMITS.note} 字，已截断`);
    if (tailText) {
      warnings.push(`尾部文本已计入备注：${tailText}`);
      confidence -= 0.05;
    }
    fieldEvidence.note = note
      ? { kind: tailText ? "derived" : "source", text: rawNote }
      : { kind: "default", text: "" };

    return {
      sourceLine,
      sourceText: line,
      task: { school, course, taskType, quantity, status, owner, weekday, dueDate: "", note },
      subtaskMarks,
      fieldEvidence,
      confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
      warnings
    };
  }

  // 文档级解析：统一契约 { version, items, unresolved, warnings }（计划书 §5.1）
  function parseTodoDocument(text) {
    const items = [];
    const unresolved = [];
    const warnings = [];
    const lines = String(text || "").split(/\r?\n/);
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (!line) return;
      const sourceLine = index + 1;
      const item = parseTodoLineItem(line, sourceLine);
      if (!item) {
        unresolved.push({ sourceLine, sourceText: line, reason: "缺少《课程》书名号结构，无法定位学校与课程" });
        return;
      }
      const issues = validateImportedTask(item.task);
      if (issues.length) {
        // Schema 校验失败的行不伪装成成功任务，送入 unresolved（冲突面板在 M4 接线）
        unresolved.push({ sourceLine, sourceText: line, reason: issues.join("；") });
        return;
      }
      items.push(item);
    });
    if (!items.length && !unresolved.length) warnings.push("没有可解析的内容");
    return { version: 1, items, unresolved, warnings };
  }

  // Schema 校验：必填、枚举、长度/范围；返回问题列表（空数组 = 通过）
  function validateImportedTask(task) {
    const issues = [];
    if (!task || typeof task !== "object") return ["任务不是对象"];
    if (!String(task.school || "").trim()) issues.push("缺少学校");
    if (!String(task.course || "").trim()) issues.push("缺少课程");
    if (String(task.school || "").length > TODO_IMPORT_LIMITS.school) issues.push("学校名过长");
    if (String(task.course || "").length > TODO_IMPORT_LIMITS.course) issues.push("课程名过长");
    if (task.taskType && !TODO_TYPE_VALUES.includes(task.taskType)) issues.push(`未知任务类型：${task.taskType}`);
    const quantity = Number(task.quantity);
    if (!Number.isInteger(quantity) || quantity < TODO_IMPORT_LIMITS.quantityMin || quantity > TODO_IMPORT_LIMITS.quantityMax) {
      issues.push(`数量必须是 ${TODO_IMPORT_LIMITS.quantityMin}-${TODO_IMPORT_LIMITS.quantityMax} 的整数`);
    }
    if (!["pending", "unsubmitted", "completed"].includes(task.status)) issues.push(`未知状态：${task.status}`);
    if (String(task.owner || "").length > TODO_IMPORT_LIMITS.owner) issues.push("负责人过长");
    if (task.weekday && !TODO_WEEKDAYS.includes(task.weekday)) issues.push(`未知星期：${task.weekday}`);
    if (String(task.note || "").length > TODO_IMPORT_LIMITS.note) issues.push("备注过长");
    return issues;
  }

  // 契约 → 旧 parseTodoLines 形状 { tasks: [9 字段], unparsed: [原文行] }，供既有调用方与测试
  function toLegacyParseResult(parsedDocument) {
    return {
      tasks: (parsedDocument.items || []).map((item) => ({
        school: item.task.school,
        course: item.task.course,
        taskType: item.task.taskType,
        quantity: item.task.quantity,
        status: item.task.status,
        owner: item.task.owner,
        weekday: item.task.weekday,
        note: item.task.note,
        subtaskMarks: item.subtaskMarks
      })),
      unparsed: (parsedDocument.unresolved || []).map((entry) => entry.sourceText)
    };
  }

  // 兼容入口：行为对齐旧解析器，另修复“尾部文本静默丢弃”缺陷（尾部进 note）
  function parseTodoLines(text) {
    return toLegacyParseResult(parseTodoDocument(text));
  }

  // ============ 导入差异分类（自 renderer.js 抽取的纯函数） ============

  // 子任务标记 + 数量 → subtasks 数组（index 从 1 起，未标记默认 pending）
  function subtasksFromMarks(quantity, marks) {
    const list = [];
    for (let index = 1; index <= Math.max(1, Number(quantity) || 1); index += 1) {
      list.push({ index, status: marks?.[index] || "pending" });
    }
    return list;
  }

  // 子任务清单与 quantity 联动：长度不足补 pending，超出截断；index 重排为 1..N
  function normalizeSubtasks(subtasks, quantity) {
    const count = Math.max(1, Number(quantity) || 1);
    const source = Array.isArray(subtasks) ? subtasks : [];
    const list = [];
    for (let index = 1; index <= count; index += 1) {
      const status = source[index - 1]?.status;
      list.push({ index, status: ["pending", "running", "done", "unconfirmed"].includes(status) ? status : "pending" });
    }
    return list;
  }

  function todoImportKey(task) {
    return [task.school, task.course, task.taskType].map((part) => String(part || "").trim()).join("\u0001");
  }

  function normalizeImportedTodoTask(task) {
    const quantity = Math.max(1, Number(task.quantity) || 1);
    const defaultMarks = task.subtaskMarks || (["completed", "unsubmitted"].includes(task.status)
      ? Object.fromEntries(Array.from({ length: quantity }, (_item, index) => [index + 1, "done"]))
      : {});
    return {
      school: task.school || "",
      course: task.course || "",
      taskType: typeof task.taskType === "string" ? task.taskType : "",
      quantity,
      status: task.status || "pending",
      owner: task.owner || "",
      weekday: TODO_WEEKDAYS.includes(task.weekday) ? task.weekday : "",
      note: task.note || "",
      subtasks: subtasksFromMarks(quantity, defaultMarks)
    };
  }

  function taskStatusLabel(status) {
    return {
      pending: "待处理",
      running: "进行中",
      evaluating: "评估中",
      paused: "已暂停",
      unsubmitted: "未提交",
      completed: "已完成"
    }[status] || "待处理";
  }

  function subtaskSummary(subtasks) {
    const list = normalizeSubtasks(subtasks, subtasks?.length || 1);
    const done = list.filter((item) => item.status === "done").map((item) => item.index);
    const unconfirmed = list.filter((item) => item.status === "unconfirmed").map((item) => item.index);
    const parts = [`${done.length}/${list.length} 已完成`];
    if (done.length) parts.push(`完成 ${done.join("/")}`);
    if (unconfirmed.length) parts.push(`待确认 ${unconfirmed.join("/")}`);
    return parts.join("，");
  }

  function importFieldDisplayValue(field, value) {
    if (field === "status") return taskStatusLabel(value);
    if (field === "subtasks") return subtaskSummary(value);
    if (field === "weekday") return value || "未设置";
    if (field === "note") return value || "无";
    return String(value ?? "");
  }

  function importFieldComparableValue(field, value) {
    if (field === "subtasks") return JSON.stringify(normalizeSubtasks(value, value?.length || 1));
    return JSON.stringify(value ?? "");
  }

  function todoImportDiffs(existing, incoming) {
    return TODO_IMPORT_FIELDS
      .filter((field) => importFieldComparableValue(field, existing[field]) !== importFieldComparableValue(field, incoming[field]))
      .map((field) => ({
        field,
        label: TODO_IMPORT_FIELD_LABELS[field],
        from: importFieldDisplayValue(field, existing[field]),
        to: importFieldDisplayValue(field, incoming[field])
      }));
  }

  // 差异分类：existingTasks / normalizeExisting 由调用方注入（renderer 传 weeklyTasks + normalizeWeeklyTask）
  // 同一稳定键对应多个现有任务时保持旧 Map 行为（后者覆盖），并把键记入 duplicateKeys 供上层提示
  function buildTodoImportPreview(parsedTasks, unparsed, existingTasks, normalizeExisting) {
    const normalize = typeof normalizeExisting === "function" ? normalizeExisting : (task) => task;
    const existingByKey = new Map();
    const duplicateKeys = [];
    for (const task of existingTasks || []) {
      const key = todoImportKey(task);
      if (existingByKey.has(key) && !duplicateKeys.includes(key)) duplicateKeys.push(key);
      existingByKey.set(key, task);
    }
    const groups = { added: [], updated: [], unchanged: [], unparsed: unparsed || [], duplicateKeys };
    (parsedTasks || []).map(normalizeImportedTodoTask).forEach((incoming) => {
      const existing = existingByKey.get(todoImportKey(incoming));
      if (!existing) {
        groups.added.push({ task: incoming, selected: true });
        return;
      }
      const diffs = todoImportDiffs(normalize(existing), incoming);
      if (diffs.length) groups.updated.push({ task: incoming, existingId: existing.id, diffs, selected: true });
      else groups.unchanged.push({ task: incoming, existingId: existing.id, selected: false });
    });
    return groups;
  }

  const TaskImportHelpers = {
    TODO_TYPE_MAP,
    TODO_TYPE_VALUES,
    TODO_WEEKDAYS,
    TODO_IMPORT_FIELDS,
    TODO_IMPORT_FIELD_LABELS,
    TODO_IMPORT_LIMITS,
    parseSubtaskNote,
    parseTodoDocument,
    validateImportedTask,
    toLegacyParseResult,
    parseTodoLines,
    subtasksFromMarks,
    normalizeSubtasks,
    todoImportKey,
    normalizeImportedTodoTask,
    taskStatusLabel,
    subtaskSummary,
    importFieldDisplayValue,
    importFieldComparableValue,
    todoImportDiffs,
    buildTodoImportPreview
  };

  if (typeof module !== "undefined" && module.exports) module.exports = TaskImportHelpers;
  if (typeof window !== "undefined") {
    window.TaskImportHelpers = TaskImportHelpers;
    // 兼容入口：旧调用方与 e2e 依赖 window.parseTodoLines
    window.parseTodoLines = parseTodoLines;
  }
})();
