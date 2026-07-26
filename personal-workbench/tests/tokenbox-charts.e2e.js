const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { isolateWeeklyTasks } = require("./e2e-isolation");

const root = path.join(__dirname, "..");
const electronPath = path.join(root, "node_modules", "electron", "dist", "electron.exe");
isolateWeeklyTasks("tokenbox-charts-e2e");

const dashboard = {
  totals: {
    total_tokens: 4000,
    official_cost: "0.1234",
    requests: 8,
    model_count: 3,
    billable_input_tokens: 2700,
    unknown_model_count: 1
  },
  models: [
    { model: "gpt-5", provider: "Codex", requests: 3, total_tokens: 2200, official_cost: "0.0700", actual_cost: "9.9000" },
    { model: "claude-sonnet-4", provider: "Claude Code", requests: 3, total_tokens: 1200, official_cost: "0.0434" },
    { model: "custom-unpriced", provider: "Codex", requests: 2, total_tokens: 600, official_cost: "" }
  ],
  daily: [
    { date: "2026-07-22", requests: 1, input_tokens: 400, output_tokens: 100, total_tokens: 500 },
    { date: "2026-07-23", requests: 2, input_tokens: 600, output_tokens: 200, total_tokens: 800 },
    { date: "2026-07-24", requests: 2, input_tokens: 700, output_tokens: 300, total_tokens: 1000 },
    { date: "2026-07-25", requests: 3, input_tokens: 1100, output_tokens: 600, total_tokens: 1700 }
  ],
  warnings: ["custom-unpriced 尚未定价"]
};

(async () => {
  let app;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: root });
    const page = await app.firstWindow({ timeout: 30000 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error?.stack || String(error)));
    await page.waitForLoadState("domcontentloaded").catch(() => {});

    await page.evaluate((snapshot) => {
      document.querySelector(".workspace")?.classList.add("tokenbox-active");
      renderTokenboxSnapshot(snapshot);
      renderTokenboxEvidence([{
        timestamp: "2026-07-25T10:00:00Z",
        model_normalized: "gpt-5",
        total_tokens: 1700,
        official_cost: "0.0500",
        actual_cost: "8.8000",
        event_id: "event_fixture",
        source_file_hash: "hash_fixture",
        source_offset: 42
      }]);
    }, dashboard);

    const result = await page.evaluate(() => ({
      trendPoints: document.querySelectorAll("#tokenbox-trend-chart [data-tokenbox-point]").length,
      trendPath: document.querySelector("#tokenbox-trend-chart .tokenbox-trend-line")?.getAttribute("d") || "",
      trendSummary: document.querySelector("#tokenbox-trend-summary")?.textContent || "",
      donutSlices: document.querySelectorAll("#tokenbox-model-chart [data-tokenbox-slice]").length,
      legendItems: document.querySelectorAll("#tokenbox-model-legend .tokenbox-model-legend-item").length,
      donutLabel: document.querySelector("#tokenbox-model-chart")?.getAttribute("aria-label") || "",
      relaySurfaceCount: document.querySelectorAll('[id*="relay"], [id*="reconciliation"]').length,
      pageText: document.querySelector("#tokenbox-view")?.textContent || "",
      modelText: document.querySelector("#tokenbox-models-body")?.textContent || "",
      evidenceText: document.querySelector("#tokenbox-evidence-body")?.textContent || "",
      evidenceCellCount: document.querySelectorAll("#tokenbox-evidence-body tr:first-child td").length
    }));

    const checks = [
      ["折线图按每日数据绘制 4 个点", result.trendPoints === 4],
      ["折线图路径已生成", /^M .+ L /.test(result.trendPath)],
      ["趋势摘要显示峰值日期", result.trendSummary.includes("2026-07-25")],
      ["圆环图按模型绘制 3 个分区", result.donutSlices === 3],
      ["圆环图例与模型数量一致", result.legendItems === 3],
      ["圆环图带总量语义说明", result.donutLabel.includes("4,000")],
      ["页面已移除外部账单入口", result.relaySurfaceCount === 0],
      ["页面文案已移除外部账单模块", !result.pageText.includes("中转站")],
      ["模型表只显示官方估算", !result.modelText.includes("9.9000")],
      ["证据表只保留官方金额且为 6 列", !result.evidenceText.includes("8.8000") && result.evidenceCellCount === 6],
      ["渲染期间无页面异常", pageErrors.length === 0]
    ];

    for (const [name, passed] of checks) {
      console.log(`  [${passed ? "PASS" : "FAIL"}] ${name}`);
    }
    const failed = checks.filter(([, passed]) => !passed);
    if (pageErrors.length) console.log(pageErrors.join("\n"));
    process.exitCode = failed.length ? 1 : 0;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
  }
})();
