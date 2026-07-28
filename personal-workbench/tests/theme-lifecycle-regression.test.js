const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("sakura is the default and all four production themes are selectable", () => {
  const html = read("index.html");
  const main = read("main.js");

  assert.match(html, /<body data-theme="sakura">/);
  for (const theme of ["sakura", "sky", "morning", "night"]) {
    assert.match(html, new RegExp(`<option value="${theme}">`));
    assert.match(main, new RegExp(`\\["sakura", "sky", "morning", "night"\\]\\.includes\\(prefs\\.theme\\)`));
  }
  assert.match(main, /theme\s*=.*\? prefs\.theme : "sakura"/);
});

test("theme switching covers global chrome, terminal, and responsive layouts", () => {
  const renderer = read("renderer.js");
  const css = read("style.css");

  assert.match(renderer, /const TERMINAL_THEMES = \{/);
  assert.match(renderer, /terminal\.options\.theme = terminalThemeFor\(normalized\)/);
  assert.match(renderer, /theme: applyWorkbenchTheme\(elements\.prefTheme\.value\)/);
  for (const theme of ["sakura", "sky", "morning", "night"]) {
    assert.match(css, new RegExp(`body\\[data-theme="${theme}"\\]`));
  }
  assert.match(css, /@media \(max-width: 1260px\)/);
  assert.match(css, /@media \(max-width: 1050px\)/);
});

test("web tabs mount lazily and extension close removes its webview", () => {
  const renderer = read("renderer.js");

  assert.match(renderer, /function createTabViewport\(tab, \{ deferWeb = true \} = \{\}\)/);
  assert.match(renderer, /viewport\.dataset\.webDeferred = "true"/);
  assert.match(renderer, /function ensureTabViewportLoaded\(tabId\)/);
  assert.match(renderer, /ensureTabViewportLoaded\(visibleTabId\)/);

  const extensionClosePaths = renderer.match(/extBody\.replaceChildren\(\)|tab-extension-body"\)\?\.replaceChildren\(\)/g) || [];
  assert.ok(extensionClosePaths.length >= 2);
  assert.doesNotMatch(renderer, /existingWebview\.src\s*=\s*"about:blank"/);
});
