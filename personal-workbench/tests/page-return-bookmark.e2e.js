const http = require("node:http");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
isolateWeeklyTasks("page-return-bookmark-e2e");
const checks = [];

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

async function waitForPageCondition(page, predicate, argument, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(predicate, argument)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`page condition timed out after ${timeout}ms`);
}

(async () => {
  let app;
  let server;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const title = req.url === "/detail" ? "Detail" : "Home";
      res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const homeUrl = `http://127.0.0.1:${port}/home`;
    const detailUrl = `http://127.0.0.1:${port}/detail`;

    console.log("  [STEP] launch isolated workbench");
    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root });
    const page = await app.firstWindow({ timeout: 30000 });
    page.setDefaultTimeout(10000);
    await page.waitForTimeout(900);

    console.log("  [STEP] create bookmark-enabled web tab");
    await page.locator("#add-tab-button").click();
    await page.locator("#tab-name").fill("Return Bookmark Test");
    await page.locator("#tab-url").fill(homeUrl);
    await page.locator("#tab-return-bookmark-enabled").check();
    await page.locator('#tab-form button[type="submit"]').click();

    const tabId = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("personal_workbench_tabs") || "[]");
      return saved.find((tab) => tab.name === "Return Bookmark Test")?.id || "";
    });
    record("web tab stores its own bookmark preference", Boolean(tabId));

    console.log("  [STEP] wait for home page");
    await waitForPageCondition(page, ({ id, expected }) => {
      const webview = document.querySelector(`.tab-viewport[data-id="${id}"] .tab-webview`);
      try {
        return webview?.getURL?.() === expected;
      } catch {
        return false;
      }
    }, { id: tabId, expected: homeUrl }, 15000);

    console.log("  [STEP] navigate to detail page");
    await page.evaluate(({ id, target }) => {
      return document.querySelector(`.tab-viewport[data-id="${id}"] .tab-webview`).loadURL(target);
    }, { id: tabId, target: detailUrl });
    await waitForPageCondition(page, ({ id, expected }) => {
      const saved = JSON.parse(localStorage.getItem("personal_workbench_tabs") || "[]");
      const tab = saved.find((candidate) => candidate.id === id);
      return tab?.lastVisitedUrl === expected.current && tab?.returnBookmarkUrl === expected.previous;
    }, { id: tabId, expected: { current: detailUrl, previous: homeUrl } });

    const rail = page.locator(`.tab-viewport[data-id="${tabId}"] .page-return-bookmark`);
    record("navigation reveals the left return bookmark", await rail.isVisible());
    console.log("  [STEP] use and hide the bookmark");
    await rail.locator(".page-return-action").click();
    await waitForPageCondition(page, ({ id, expected }) => {
      const webview = document.querySelector(`.tab-viewport[data-id="${id}"] .tab-webview`);
      try {
        return webview?.getURL?.() === expected;
      } catch {
        return false;
      }
    }, { id: tabId, expected: homeUrl });
    const swapped = await page.evaluate((id) => {
      const saved = JSON.parse(localStorage.getItem("personal_workbench_tabs") || "[]");
      const tab = saved.find((candidate) => candidate.id === id);
      return { current: tab?.lastVisitedUrl, previous: tab?.returnBookmarkUrl };
    }, tabId);
    record(
      "bookmark returns and keeps the departed page for a second toggle",
      swapped.current === homeUrl && swapped.previous === detailUrl,
      JSON.stringify(swapped)
    );

    await rail.locator(".page-return-hide").click();
    const hiddenState = await page.evaluate((id) => {
      const saved = JSON.parse(localStorage.getItem("personal_workbench_tabs") || "[]");
      return saved.find((candidate) => candidate.id === id)?.returnBookmarkHidden;
    }, tabId);
    record("hide control persists only for this tab", hiddenState === true && !(await rail.isVisible()));

    console.log("  [STEP] restore and then disable from tab settings");
    await page.locator(`.tab-item[data-id="${tabId}"] .tab-menu`).click();
    await page.locator("#tab-return-bookmark-visible").check();
    await page.locator('#tab-form button[type="submit"]').click();
    await waitForPageCondition(page, (id) => {
      const railNode = document.querySelector(`.tab-viewport[data-id="${id}"] .page-return-bookmark`);
      return railNode && !railNode.hidden;
    }, tabId);
    record("tab settings can show a bookmark hidden inside the page", true);

    await page.locator(`.tab-item[data-id="${tabId}"] .tab-menu`).click();
    await page.locator("#tab-return-bookmark-enabled").uncheck();
    await page.locator('#tab-form button[type="submit"]').click();
    const disabledState = await page.evaluate((id) => {
      const saved = JSON.parse(localStorage.getItem("personal_workbench_tabs") || "[]");
      const tab = saved.find((candidate) => candidate.id === id);
      return {
        enabled: tab?.returnBookmarkEnabled,
        hasCurrent: Object.hasOwn(tab || {}, "lastVisitedUrl"),
        hasPrevious: Object.hasOwn(tab || {}, "returnBookmarkUrl")
      };
    }, tabId);
    record(
      "disabling the feature stops retaining page history",
      disabledState.enabled === false && !disabledState.hasCurrent && !disabledState.hasPrevious,
      JSON.stringify(disabledState)
    );
  } catch (error) {
    record("page return bookmark E2E completed", false, String(error?.stack || error));
  } finally {
    if (app) await app.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve)).catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== Page return bookmark E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
