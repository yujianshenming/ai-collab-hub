const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
isolateWeeklyTasks("theme-e2e");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const userDataDir = process.env.PERSONAL_WORKBENCH_USER_DATA;

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

(async () => {
  let app;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${userDataDir}`],
      cwd: root
    });
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1200);

    record("default theme is sky", await page.locator("body").getAttribute("data-theme") === "sky");

    await page.evaluate(() => {
      localStorage.setItem("personal_workbench_tabs", JSON.stringify([
        { id: "lazy-1", name: "Lazy 1", url: "https://example.invalid/1" },
        { id: "lazy-2", name: "Lazy 2", url: "https://example.invalid/2" },
        { id: "lazy-3", name: "Lazy 3", url: "https://example.invalid/3" }
      ]));
    });
    await page.reload();
    await page.waitForTimeout(1200);

    const idle = await page.evaluate(() => ({
      viewports: document.querySelectorAll(".tab-viewport").length,
      deferred: document.querySelectorAll("[data-web-deferred]").length,
      webviews: document.querySelectorAll("webview").length
    }));
    record("saved tabs stay deferred on task center", idle.viewports === 3 && idle.deferred === 3 && idle.webviews === 0, JSON.stringify(idle));

    await page.locator("#menu-more-button").click();
    await page.locator("#menu-prefs-button").click();
    await page.locator("#pref-theme").selectOption("morning");
    await page.locator("#prefs-form .primary-button").click();
    await page.reload();
    await page.waitForTimeout(800);
    record("saved theme survives reload", await page.locator("body").getAttribute("data-theme") === "morning");

    const active = await page.evaluate(async () => {
      activateTab("lazy-1");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        webviews: document.querySelectorAll("webview").length,
        deferred: document.querySelectorAll("[data-web-deferred]").length,
        active: document.querySelector(".tab-viewport.active")?.dataset.id || ""
      };
    });
    record("activating one tab mounts only one webview", active.webviews === 1 && active.deferred === 2 && active.active === "lazy-1", JSON.stringify(active));
  } catch (error) {
    record("theme and lifecycle e2e completed", false, String(error?.stack || error));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n===== Theme and lifecycle E2E =====");
  console.log(`Total ${checks.length}, passed ${checks.length - failed.length}, failed ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
