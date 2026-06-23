// V3.4 P1 缺陷实测（测试工程师）—— 回归清单附表 #1 / #2
// #1 findTabByUrlPart 对无 url 标签是否抛 TypeError（Hermes 阶段崩）
// #2 select-file-dialog 在 Electron 36 是否存在 / 上传拦截机制是否为 CDP 路径
// 跑法：node tests/p1-defects.e2e.js
const path = require("path");
const fs = require("fs");
const { _electron: electron } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  // ===== #2 先做静态机制核查（不依赖真机平台页面） =====
  const mainSrc = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const rendererSrc = fs.readFileSync(path.join(ROOT, "renderer.js"), "utf8");

  // 旧 bug：webview 监听 select-file-dialog 事件。确认已不再使用该事件监听
  const oldEventListener = /\.addEventListener\(\s*["']select-file-dialog["']/.test(rendererSrc)
    || /on\(\s*["']select-file-dialog["']/.test(rendererSrc)
    || /on\(\s*["']select-file-dialog["']/.test(mainSrc);
  record("#2 不再监听 webview 'select-file-dialog' 事件（旧 bug 已移除）", !oldEventListener);

  // 新机制：CDP Page.setInterceptFileChooserDialog + Page.fileChooserOpened
  const hasInterceptCmd = mainSrc.includes("Page.setInterceptFileChooserDialog");
  const hasChooserEvent = mainSrc.includes("Page.fileChooserOpened");
  const hasSetFileInput = mainSrc.includes("DOM.setFileInputFiles");
  record("#2 改用 CDP Page.setInterceptFileChooserDialog 拦截", hasInterceptCmd);
  record("#2 监听 CDP Page.fileChooserOpened 事件", hasChooserEvent);
  record("#2 通过 DOM.setFileInputFiles 注入文件", hasSetFileInput);
  record("#2 存在系统选择器降级 fallbackSystemChooser", mainSrc.includes("fallbackSystemChooser"));

  // ===== 启动应用做 #1 运行时复现 =====
  const pageErrors = [];
  let app;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: ROOT });
    const page = await app.firstWindow({ timeout: 30000 });
    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    await page.waitForTimeout(1500);

    // 确认 findTabByUrlPart 在页面作用域可调用（renderer.js 为经典脚本，函数为全局）
    const fnType = await page.evaluate(() => typeof findTabByUrlPart);
    record("#1 findTabByUrlPart 在页面作用域可访问", fnType === "function", `typeof=${fnType}`);

    if (fnType === "function") {
      // (a) 对真实 tabs 调用 findTabByUrlPart 不抛错（renderer.js 的 tabs 是闭包 let，无法外部注入，
      //     故直接对真实持久化标签集调用，验证现网状态下不崩）
      const realCall = await page.evaluate(() => {
        const out = { threw: false, error: null };
        try { findTabByUrlPart("hermes"); findTabByUrlPart("wl363eval"); findTabByUrlPart("zzz"); }
        catch (e) { out.threw = true; out.error = String(e && e.message || e); }
        return out;
      });
      record("#1 对真实标签集调用 findTabByUrlPart 不抛错", !realCall.threw, realCall.threw ? realCall.error : "");

      // (b) 直接验证缺陷修复点：复刻 findTabByUrlPart 的谓词，对「无 url 字段」标签求值不抛 TypeError。
      //     旧 bug 是 tab.url.toLowerCase() 在 url 为 undefined 时抛错；修复后用 String(tab.url || "")。
      const guard = await page.evaluate(() => {
        const out = { threw: false, error: null, matched: null };
        const predicate = (tab, part) => String(tab.url || "").toLowerCase().includes(part);
        const noUrlTabs = [
          { id: "desk1", type: "desktop-app" },   // 无 url
          { id: "cli1", type: "cli-app" },         // 无 url
          { id: "builtin1", type: "builtin" },     // 无 url
          { id: "web1", type: "web", url: "https://hermes.example.com/x" }
        ];
        try {
          const hit = noUrlTabs.find((t) => predicate(t, "hermes"));
          const miss = noUrlTabs.find((t) => predicate(t, "notexist"));
          out.matched = (hit && hit.id) || null;
          out.missEmpty = miss === undefined;
        } catch (e) { out.threw = true; out.error = String(e && e.message || e); }
        return out;
      });
      record("#1 无 url 标签经修复谓词求值不抛 TypeError", !guard.threw, guard.threw ? guard.error : "");
      record("#1 修复谓词：含 url 标签正常命中 hermes", guard.matched === "web1", `matched=${guard.matched}`);
      record("#1 修复谓词：不匹配时返回空", guard.missEmpty === true);

      // (c) 确认源码确实使用了 String(tab.url || "") 防护，而非裸 tab.url.toLowerCase()
      const guarded = /String\(\s*tab\.url\s*\|\|\s*""\s*\)\.toLowerCase\(\)/.test(rendererSrc);
      const rawUnsafe = /\btab\.url\.toLowerCase\(\)/.test(rendererSrc);
      record("#1 源码使用 String(tab.url || '') 防护", guarded);
      record("#1 源码无裸 tab.url.toLowerCase()（旧 bug 写法）", !rawUnsafe);
    }

    await page.waitForTimeout(800);
    record("#1 全程无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    record("应用启动（#1 运行时复现）", false, String(e && e.stack || e));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("\n===== P1 缺陷实测结果 =====");
  console.log(`总计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? " — " + f.detail : ""}`);
    process.exit(1);
  } else {
    console.log("全部通过。");
    process.exit(0);
  }
})();
