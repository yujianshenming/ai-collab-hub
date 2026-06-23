// V3.4 安全 HTTP 运行时验证（测试工程师）—— 回归清单 §6 鉴权 + 静态路径穿越
// 启动真实应用，对本地服务 127.0.0.1:38924 发请求：
//   - 七条敏感路由无 token → 401
//   - 带正确 token → 200（token 经页面 getSessionToken 取得）
//   - /local-apps 未注册 tabId → 404；..%2F 穿越 → 403/404（不泄露文件）
// 跑法：node tests/security-http.e2e.js
const path = require("path");
const http = require("http");
const { _electron: electron } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PORT = 38924;

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

function httpGet(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
  });
}

(async () => {
  let app;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: ROOT });
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForTimeout(2000); // 等本地服务 listen

    const secureRoutes = ["/cookies", "/state", "/tabs", "/active-tab", "/active-task", "/broadcast"];
    let all401 = true;
    const codes = {};
    for (const r of secureRoutes) {
      const res = await httpGet(r);
      codes[r] = res.status;
      if (res.status !== 401) all401 = false;
    }
    record("敏感路由无 token 全部 401", all401, JSON.stringify(codes));

    // 取真实 token（主进程通过 IPC 暴露给页面）
    const token = await page.evaluate(() => window.workbench.getSessionToken());
    record("页面可取得 sessionToken", typeof token === "string" && token.length > 0, `len=${token ? token.length : 0}`);

    if (token) {
      const ok = await httpGet(`/tabs?token=${encodeURIComponent(token)}`);
      record("带正确 token 访问 /tabs 返回 200", ok.status === 200, `status=${ok.status}`);
      const bad = await httpGet(`/tabs?token=wrong_${token}`);
      record("错误 token 访问 /tabs 仍 401", bad.status === 401, `status=${bad.status}`);
    }

    // 静态服务：未注册 tabId → 404（不泄露）
    const unreg = await httpGet("/local-apps/nonexistent-tab/index.html");
    record("未注册 local-app tabId 返回 404", unreg.status === 404, `status=${unreg.status}`);

    // 路径穿越：注册不了 base，这里验证穿越请求不会 200 泄露文件（404/403 均可接受）
    const trav = await httpGet("/local-apps/nonexistent-tab/..%2F..%2F..%2Fmain.js");
    record("路径穿越请求不返回 200（不泄露文件）", trav.status !== 200, `status=${trav.status}`);

  } catch (e) {
    record("安全 HTTP e2e 执行", false, String(e && e.stack || e));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("\n===== 安全 HTTP 运行时结果 =====");
  console.log(`总计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? " — " + f.detail : ""}`);
    process.exit(1);
  } else {
    console.log("全部通过。");
    process.exit(0);
  }
})();
