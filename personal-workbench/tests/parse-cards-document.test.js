const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadParseCardsDocument() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const rendererSource = fs.readFileSync(rendererPath, "utf8");
  const start = rendererSource.indexOf("const CARD_FIELD_DEFS = [");
  const endMarker = "window.parseCardsDocument = parseCardsDocument;";
  const end = rendererSource.indexOf(endMarker, start);

  assert.notEqual(start, -1, "renderer.js should contain cards parsing block");
  assert.notEqual(end, -1, "renderer.js should expose parseCardsDocument on window");

  const sandbox = { window: {} };
  vm.runInNewContext(
    rendererSource.slice(start, end + endMarker.length),
    sandbox,
    { filename: rendererPath }
  );
  return sandbox.window.parseCardsDocument;
}

const parseCardsDocument = loadParseCardsDocument();

// vm 沙箱产物与本 realm 原型不同，deepEqual 前先 JSON 拍平
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const FENCE = "```";

const SAMPLE = [
  "总任务名称：危机公关实战训练",
  "任务描述：本任务训练学生在突发舆情情境中完成信息研判、回应策略制定与新闻发布。",
  "封面图描述：一名公关经理站在新闻发布会聚光灯下。",
  "",
  "## 卡片一：舆情爆发",
  "建议轮次：6",
  "阶段描述：学生进入突发舆情情境，识别关键信息。",
  "开场白：你好，我是公关部经理林岚，刚刚我们的产品被曝出质量问题，请你先梳理已知信息。",
  "提示词：",
  FENCE + "markdown",
  "## Role",
  "你是舆情训练官。",
  "",
  "## Jump Condition",
  "- 满足条件后仅输出跳转词",
  FENCE,
  "",
  "## 卡片二",
  "卡片名称：回应策略制定",
  "建议轮次：8 轮",
  "阶段描述：基于研判结果制定回应策略。",
  "开场白：现在我们需要确定对外回应的口径与渠道。",
  "提示词：",
  FENCE,
  "## Role",
  "策略教练",
  "提示词：这行是围栏内的干扰标签，不应被识别",
  FENCE,
  "",
  "卡片名称：新闻发布演练",
  "建议轮次：10",
  "阶段描述：模拟新闻发布会答记者问。",
  "开场白：发布会即将开始。",
  "提示词：无围栏的提示词正文第一行",
  "第二行内容",
  "",
  "## 卡片四：复盘总结",
  "建议轮次：4",
  "阶段描述：复盘整个危机处理过程。",
  "开场白：我们来复盘这次危机应对。",
  "提示词：",
  FENCE,
  "## Role",
  "复盘导师",
  FENCE,
  "",
  "（这是一段被故意打乱格式的内容，无法归入任何字段）",
  "乱序行第二行",
  "",
  "## 评价标准",
  "维度一：信息研判（30分）",
  "评价项详细要求：",
  FENCE + "markdown",
  "- 能准确识别舆情关键信息。",
  FENCE,
  "---",
  "维度二：回应策略（30分）",
  "",
  "测试人格：",
  FENCE,
  "你是一名参与危机公关训练的学生，表达不够完整，需要追问引导。",
  FENCE
].join("\n");

test("parses real-shaped hermes output: meta + 4 cards + sections", () => {
  const result = parseCardsDocument(SAMPLE);

  assert.equal(result.taskMeta.taskName, "危机公关实战训练");
  assert.match(result.taskMeta.taskDescription, /突发舆情情境/);
  assert.match(result.taskMeta.coverDescription, /新闻发布会聚光灯/);

  assert.equal(result.cards.length, 4);
  assert.deepEqual(plain(result.cards.map((card) => card.name)), [
    "舆情爆发", "回应策略制定", "新闻发布演练", "复盘总结"
  ]);
  assert.equal(result.cards[0].rounds, "6");
  assert.equal(result.cards[1].rounds, "8 轮");
  assert.match(result.cards[2].stageDescription, /答记者问/);
  assert.match(result.cards[3].opening, /复盘这次危机应对/);
});

test("prompt copies code block content without fences, keeping inner lines", () => {
  const result = parseCardsDocument(SAMPLE);

  assert.equal(
    result.cards[0].prompt,
    "## Role\n你是舆情训练官。\n\n## Jump Condition\n- 满足条件后仅输出跳转词"
  );
  assert.ok(!result.cards[0].prompt.includes(FENCE), "prompt must not contain fences");
  // 围栏内出现的「提示词：」标签不应被识别为锚点
  assert.match(result.cards[1].prompt, /围栏内的干扰标签/);
  assert.equal(result.cards[1].prompt.split("\n").length, 3);
});

test("prompt without code fence falls back to plain accumulation", () => {
  const result = parseCardsDocument(SAMPLE);
  assert.equal(result.cards[2].prompt, "无围栏的提示词正文第一行\n第二行内容");
});

test("heading + name label on the same card does not duplicate cards", () => {
  const result = parseCardsDocument(SAMPLE);
  // 卡片二：`## 卡片二` 标题后紧跟 `卡片名称：回应策略制定`，应为同一张卡
  assert.equal(result.cards.filter((card) => /回应策略/.test(card.name)).length, 1);
});

test("evaluation and persona are captured as whole raw sections", () => {
  const result = parseCardsDocument(SAMPLE);

  assert.match(result.evaluation, /维度一：信息研判（30分）/);
  assert.match(result.evaluation, /维度二：回应策略（30分）/);
  assert.ok(result.evaluation.includes(FENCE + "markdown"), "evaluation keeps inner fences verbatim");
  assert.ok(!result.evaluation.includes("测试人格"), "evaluation stops at persona anchor");
  assert.match(result.testPersona, /表达不够完整/);
});

test("garbled segment lands in unparsed without blocking parsed cards", () => {
  const result = parseCardsDocument(SAMPLE);

  assert.equal(result.cards.length, 4);
  assert.ok(result.unparsed.some((block) => block.includes("故意打乱格式")), "garbled block captured");
});

test("empty/invalid input returns empty structure", () => {
  for (const input of ["", null, undefined, "   \n  "]) {
    const result = parseCardsDocument(input);
    assert.deepEqual(plain(result.cards), []);
    assert.deepEqual(plain(result.taskMeta), {});
    assert.equal(result.evaluation, "");
    assert.equal(result.testPersona, "");
  }
});
