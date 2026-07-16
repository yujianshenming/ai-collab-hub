const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadWeeklyReportHelpers() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const source = fs.readFileSync(rendererPath, "utf8");

  const start = source.indexOf("function getIsoWeekNumber(date = new Date()) {");
  const endMarker = "window.normalizeWeeklyReportDefaults = normalizeWeeklyReportDefaults;";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, "renderer.js should contain getIsoWeekNumber");
  assert.notEqual(end, -1, "renderer.js should expose weekly report helpers on window");

  const sliceEnd = end + endMarker.length;
  const block = source.slice(start, sliceEnd);

  const sandbox = {
    window: {},
    console,
    Date,
    Math,
    String,
    Number,
    Array,
    Object,
    Map,
    Boolean
  };
  vm.runInNewContext(block, sandbox, { filename: rendererPath });
  return sandbox.window;
}

const helpers = loadWeeklyReportHelpers();

test("applyReportTitlePattern falls back to M{month}W{weekOfMonth}周报", () => {
  const title = helpers.applyReportTitlePattern("2026-W29", "");
  assert.match(title, /^M\d+W\d+周报$/);
});

test("applyReportTitlePattern expands known placeholders", () => {
  const title = helpers.applyReportTitlePattern(
    "2026-W29",
    "{period} / {year}-W{isoWeek} / M{month}W{weekOfMonth}"
  );
  assert.equal(title.includes("2026-W29"), true);
  assert.equal(title.includes("2026-W"), true);
  assert.match(title, /M\d+W\d+/);
});

test("shiftReportPeriod moves by whole ISO weeks", () => {
  const next = helpers.shiftReportPeriod("2026-W29", 1);
  const prev = helpers.shiftReportPeriod("2026-W29", -1);
  assert.equal(next, "2026-W30");
  assert.equal(prev, "2026-W28");
});

test("normalizeWeeklyReportDefaults trims and clamps dirty input", () => {
  const normalized = helpers.normalizeWeeklyReportDefaults({
    author: "  刘毅  ",
    titlePattern: "  {period}周报  ",
    extra: "drop-me"
  });
  assert.equal(normalized.author, "刘毅");
  assert.equal(normalized.titlePattern, "{period}周报");
  const empty = helpers.normalizeWeeklyReportDefaults(null);
  assert.equal(empty.author, "");
  assert.equal(empty.titlePattern, "");
});
