const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadReturnBookmarkHelpers() {
  const rendererPath = path.resolve(__dirname, "..", "renderer.js");
  const source = fs.readFileSync(rendererPath, "utf8");
  const start = source.indexOf("// ============ 网页返回书签（纯函数，供渲染层与测试共用） ============");
  const endMarker = "window.swapReturnBookmarkState = swapReturnBookmarkState;";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, "return bookmark helpers block missing");
  assert.notEqual(end, -1, "return bookmark helpers export missing");

  const sandbox = {
    window: {},
    URL,
    String,
    Array,
    Object
  };
  vm.runInNewContext(source.slice(start, end + endMarker.length), sandbox, { filename: rendererPath });
  return sandbox.window;
}

const helpers = loadReturnBookmarkHelpers();

test("disabled tabs do not retain navigation history", () => {
  const original = {
    url: "https://example.test/home",
    returnBookmarkEnabled: false
  };
  const next = helpers.nextReturnBookmarkState(original, "https://example.test/detail");
  assert.equal(next.lastVisitedUrl, undefined);
  assert.equal(next.returnBookmarkUrl, undefined);
});

test("first load does not create a self-referencing bookmark", () => {
  const next = helpers.nextReturnBookmarkState({
    url: "https://example.test/home",
    returnBookmarkEnabled: true
  }, "https://example.test/home");
  assert.equal(next.lastVisitedUrl, "https://example.test/home");
  assert.equal(next.returnBookmarkUrl || "", "");
});

test("navigation stores the previous page and bookmark click swaps both pages", () => {
  const navigated = helpers.nextReturnBookmarkState({
    url: "https://example.test/home",
    lastVisitedUrl: "https://example.test/home",
    returnBookmarkEnabled: true
  }, "https://example.test/detail");
  assert.equal(navigated.lastVisitedUrl, "https://example.test/detail");
  assert.equal(navigated.returnBookmarkUrl, "https://example.test/home");

  const returned = helpers.swapReturnBookmarkState(navigated, "https://example.test/detail");
  assert.equal(returned.target, "https://example.test/home");
  assert.equal(returned.tab.lastVisitedUrl, "https://example.test/home");
  assert.equal(returned.tab.returnBookmarkUrl, "https://example.test/detail");

  const forwardAgain = helpers.swapReturnBookmarkState(returned.tab, returned.target);
  assert.equal(forwardAgain.target, "https://example.test/detail");
  assert.equal(forwardAgain.tab.returnBookmarkUrl, "https://example.test/home");
});

test("bookmark only accepts loadable web and file URLs", () => {
  assert.equal(helpers.normalizeReturnBookmarkUrl("javascript:alert(1)"), "");
  assert.equal(helpers.normalizeReturnBookmarkUrl("not a url"), "");
  assert.equal(helpers.normalizeReturnBookmarkUrl("https://example.test/a"), "https://example.test/a");
  assert.equal(helpers.normalizeReturnBookmarkUrl("file:///C:/tmp/a.html"), "file:///C:/tmp/a.html");
});
