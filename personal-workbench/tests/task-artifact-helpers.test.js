const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadTaskArtifactHelpers() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const source = fs.readFileSync(rendererPath, "utf8");

  const start = source.indexOf("// ============ 任务产物徽章（纯函数，无副作用，供测试注入） ============");
  const endMarker = "window.isCardsArtifactName = isCardsArtifactName;";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, "renderer.js should contain artifact helpers");
  assert.notEqual(end, -1, "renderer.js should expose artifact helpers on window");

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

const helpers = loadTaskArtifactHelpers();

test("isChatArtifactName matches dialogue naming variants", () => {
  assert.equal(helpers.isChatArtifactName("dialogue.json"), true);
  assert.equal(helpers.isChatArtifactName("dialogue (2).json"), true);
  assert.equal(helpers.isChatArtifactName("chat_log.txt"), true);
  assert.equal(helpers.isChatArtifactName("eval_report.pdf"), false);
});

test("isReportArtifactName matches eval_report naming", () => {
  assert.equal(helpers.isReportArtifactName("eval_report.pdf"), true);
  assert.equal(helpers.isReportArtifactName("evaluation-report.html"), true);
  assert.equal(helpers.isReportArtifactName("dialogue.json"), false);
});

test("isCardsArtifactName only matches cards.md", () => {
  assert.equal(helpers.isCardsArtifactName("cards.md"), true);
  assert.equal(helpers.isCardsArtifactName("Cards.MD"), true);
  assert.equal(helpers.isCardsArtifactName("cards.txt"), false);
});

test("taskArtifactsFromPathsAndFiles marks stale saved paths as missing", () => {
  const artifacts = helpers.taskArtifactsFromPathsAndFiles({
    chatLogPath: "C:/tasks/t1/dialogue.json",
    reportPath: "C:/tasks/t1/eval_report.pdf"
  }, [
    { name: "cards.md", path: "C:/tasks/t1/cards.md" },
    { name: "other.txt", path: "C:/tasks/t1/other.txt" }
  ]);
  assert.equal(artifacts.chat.ready, false);
  assert.equal(artifacts.chat.path, "");
  assert.equal(artifacts.report.ready, false);
  assert.equal(artifacts.report.path, "");
  assert.equal(artifacts.cards.ready, true);
  assert.equal(artifacts.cards.path, "C:/tasks/t1/cards.md");
});

test("taskArtifactsFromPathsAndFiles keeps a saved path ready only when the file exists", () => {
  const artifacts = helpers.taskArtifactsFromPathsAndFiles({
    chatLogPath: "C:/tasks/t1/dialogue.json",
    reportPath: "C:/tasks/t1/eval_report.pdf"
  }, [
    { name: "dialogue.json", path: "C:/tasks/t1/dialogue.json" },
    { name: "eval_report.pdf", path: "C:/tasks/t1/eval_report.pdf" }
  ]);
  assert.equal(artifacts.chat.ready, true);
  assert.equal(artifacts.report.ready, true);
});

test("taskArtifactsFromPathsAndFiles discovers files when paths empty", () => {
  const artifacts = helpers.taskArtifactsFromPathsAndFiles({}, [
    { name: "dialogue.json", path: "C:/tasks/t2/dialogue.json" },
    { name: "eval_report.pdf", path: "C:/tasks/t2/eval_report.pdf" },
    { name: "cards.md", path: "C:/tasks/t2/cards.md" }
  ]);
  assert.equal(artifacts.chat.ready, true);
  assert.equal(artifacts.report.ready, true);
  assert.equal(artifacts.cards.ready, true);
  assert.equal(artifacts.chat.path.endsWith("dialogue.json"), true);
});

test("taskArtifactsFromPathsAndFiles marks missing badges when nothing found", () => {
  const artifacts = helpers.taskArtifactsFromPathsAndFiles({}, [{ name: "readme.txt", path: "C:/tasks/t3/readme.txt" }]);
  assert.equal(artifacts.chat.ready, false);
  assert.equal(artifacts.report.ready, false);
  assert.equal(artifacts.cards.ready, false);
  assert.equal(artifacts.chat.name, "dialogue.json");
  assert.equal(artifacts.report.name, "eval_report.pdf");
  assert.equal(artifacts.cards.name, "cards.md");
});
