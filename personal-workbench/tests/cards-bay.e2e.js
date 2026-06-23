// V3.4 卡片舱 E2E（测试工程师）—— v3.4-test-plan 第二节 E1-E6 + spec §5.2-5.4
// 在真实 Electron 渲染进程内驱动卡片舱渲染/复制/流式/徽章/unparsed/引导，做断言。
// renderer.js 为经典脚本，parseCardsDocument / renderRailCards / railCardFieldRow /
// updateCardStreamHighlight / railCardsState / railCardsStreamOn / elements 均为页面全局。
// 跑法：node tests/cards-bay.e2e.js
const path = require("path");
const fs = require("fs");
const { _electron: electron } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const SAMPLE = fs.readFileSync(path.join(ROOT, "wb-audit", "sample-cards.md"), "utf8");

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  const pageErrors = [];
  let app;
  try {
    app = await electron.launch({ executablePath: electronPath, args: ["."], cwd: ROOT });
    const page = await app.firstWindow({ timeout: 30000 });
    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    await page.waitForTimeout(1500);

    // 在页面内安装测试夹具：用样本驱动卡片舱渲染（绕过任务流水线依赖，但用真实渲染函数）
    const setup = await page.evaluate((sampleText) => {
      const out = { ok: false, error: null };
      try {
        // 伪任务对象：cardCopied 持久化到内存即可（不调真实 IPC）
        const fakeTask = { id: "e2e-task", cardCopied: {} };
        window.__e2eTask = fakeTask;
        // 拦截 updateTaskFields，避免依赖真实任务存储；记录写回内容用于 E2 校验
        window.__e2eWrites = [];
        window.updateTaskFields = async (id, fields) => {
          window.__e2eWrites.push({ id, fields });
          if (fields && fields.cardCopied) fakeTask.cardCopied = fields.cardCopied;
          return fakeTask;
        };
        // 用真实解析器解析样本
        window.__e2eParsed = parseCardsDocument(sampleText);
        railCardsState = { taskId: fakeTask.id, parsed: window.__e2eParsed, mtime: 1, missing: false, error: "" };
        renderRailCards(fakeTask);
        out.ok = true;
      } catch (e) { out.error = String(e && e.stack || e); }
      return out;
    }, SAMPLE);
    record("夹具：用真实 renderRailCards 渲染样本卡片舱", setup.ok, setup.error || "");

    if (!setup.ok) throw new Error("setup failed");

    // ===== E1 逐字段复制逐字节一致（重点 prompt 无围栏 + evaluation 整段） =====
    // 复制按钮把 parsed 字段原文写入 clipboard；逐行点按钮后读 Electron clipboard 比对。
    const e1 = await page.evaluate(async () => {
      const parsed = window.__e2eParsed;
      const results = [];
      // 取卡片1 提示词行、卡片1 开场白行、评价标准 meta 行
      const expectMap = {
        "card:0:prompt": parsed.cards[0].prompt,
        "card:0:opening": parsed.cards[0].opening,
        "card:2:prompt": parsed.cards[2].prompt,
        "meta:evaluation": parsed.evaluation,
        "meta:testPersona": parsed.testPersona
      };
      for (const key of Object.keys(expectMap)) {
        const row = document.querySelector(`.rc-row[data-key="${key}"]`);
        if (!row) { results.push({ key, ok: false, reason: "row not found" }); continue; }
        const btn = row.querySelector(".rc-copy");
        // 清空剪贴板再复制
        await navigator.clipboard.writeText("__cleared__");
        btn.click();
        // 等复制完成（copyCardField 是 async；轮询剪贴板）
        let got = "";
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 30));
          got = await navigator.clipboard.readText().catch(() => "");
          if (got !== "__cleared__") break;
        }
        const expected = expectMap[key];
        // Windows 剪贴板 readText 会把 \n 规范化为 \r\n；复制写入的是原文，比对时按此归一
        const exact = got === expected;
        const crlfMatch = got.replace(/\r\n/g, "\n") === expected;
        results.push({ key, ok: exact || crlfMatch, exact, crlfMatch, expectedLen: expected.length, gotLen: got.length });
      }
      return results;
    });
    for (const r of e1) {
      const note = r.exact ? "完全一致" : (r.crlfMatch ? "一致(剪贴板回读CRLF归一后)" : `期望${r.expectedLen}字/实得${r.gotLen}字`);
      record(`E1 复制逐字节一致 [${r.key}]`, r.ok, note);
    }
    // 额外硬断言：prompt 不含围栏 ```
    const e1fence = await page.evaluate(() => window.__e2eParsed.cards[0].prompt.includes("```"));
    record("E1 提示词复制不含 ``` 围栏", e1fence === false);

    // ===== E2 已复制状态持久化（落库形状 + 行 .copied + 重渲后仍在） =====
    const e2 = await page.evaluate(() => {
      const writes = window.__e2eWrites;
      const lastWrite = writes[writes.length - 1];
      const task = window.__e2eTask;
      // 重新渲染（模拟任务舱重渲/重启读取持久化），断言已复制行仍带 copied
      renderRailCards(task);
      const promptRow = document.querySelector('.rc-row[data-key="card:0:prompt"]');
      return {
        wroteCardCopied: Boolean(lastWrite && lastWrite.fields && lastWrite.fields.cardCopied),
        copiedKeysCount: Object.keys(task.cardCopied || {}).length,
        promptRowCopiedAfterRerender: promptRow ? promptRow.classList.contains("copied") : false
      };
    });
    record("E2 复制写回 cardCopied 字段（落库形状）", e2.wroteCardCopied);
    record("E2 已复制键数 >0（持久到任务数据）", e2.copiedKeysCount > 0, `count=${e2.copiedKeysCount}`);
    record("E2 重渲染后已复制行仍标记 copied（重启不丢）", e2.promptRowCopiedAfterRerender);

    // ===== E3 流式模式：高亮第一个未复制字段，复制后推进，全部完成提示 =====
    const e3 = await page.evaluate(async () => {
      const out = {};
      const task = { id: "e2e-stream", cardCopied: {} };
      window.updateTaskFields = async (_id, fields) => { if (fields.cardCopied) task.cardCopied = fields.cardCopied; return task; };
      railCardsState = { taskId: task.id, parsed: window.__e2eParsed, mtime: 2, missing: false, error: "" };
      renderRailCards(task);
      // 开启流式
      railCardsStreamOn = true;
      updateCardStreamHighlight();
      const rowsBefore = [...document.querySelectorAll(".rc-row")];
      const firstHi = document.querySelector(".rc-row.stream-now");
      out.highlightCount1 = document.querySelectorAll(".rc-row.stream-now").length;
      out.firstHighlightKey = firstHi ? firstHi.dataset.key : null;
      out.firstRowKey = rowsBefore.length ? rowsBefore[0].dataset.key : null;
      // 复制第一个高亮字段 → 应推进到下一个未复制字段
      const btn1 = firstHi.querySelector(".rc-copy");
      btn1.click();
      await new Promise((r) => setTimeout(r, 120));
      const secondHi = document.querySelector(".rc-row.stream-now");
      out.secondHighlightKey = secondHi ? secondHi.dataset.key : null;
      out.advanced = out.secondHighlightKey && out.secondHighlightKey !== out.firstHighlightKey;
      out.secondNotCopied = secondHi ? !secondHi.classList.contains("copied") : false;
      // 中途关闭开关 → 高亮消失
      railCardsStreamOn = false;
      updateCardStreamHighlight();
      out.highlightAfterOff = document.querySelectorAll(".rc-row.stream-now").length;
      return out;
    });
    record("E3 开启流式后恰高亮一个字段", e3.highlightCount1 === 1, `count=${e3.highlightCount1}`);
    record("E3 高亮的是第一个（未复制）字段", e3.firstHighlightKey === e3.firstRowKey, `hi=${e3.firstHighlightKey} first=${e3.firstRowKey}`);
    record("E3 复制后高亮推进到下一个未复制字段", Boolean(e3.advanced), `${e3.firstHighlightKey}→${e3.secondHighlightKey}`);
    record("E3 推进目标未被复制（跳过已复制）", e3.secondNotCopied === true);
    record("E3 关闭开关后高亮消失", e3.highlightAfterOff === 0);

    // 全部完成提示：复制完所有字段后 announceDone 应触发（断言 next 为空时不再高亮）
    const e3done = await page.evaluate(async () => {
      const rows = [...document.querySelectorAll(".rc-row")];
      const task = { id: "e2e-done", cardCopied: {} };
      window.updateTaskFields = async (_id, fields) => { if (fields.cardCopied) task.cardCopied = fields.cardCopied; return task; };
      // 直接把所有行标记 copied，再调用 highlight(announceDone=true) 验证无高亮、无异常
      rows.forEach((r) => r.classList.add("copied"));
      railCardsStreamOn = true;
      let threw = false;
      try { updateCardStreamHighlight(true); } catch (e) { threw = true; }
      const hi = document.querySelectorAll(".rc-row.stream-now").length;
      railCardsStreamOn = false;
      return { threw, hi };
    });
    record("E3 全部已复制时无高亮且不抛错（完成态）", e3done.threw === false && e3done.hi === 0);

    // ===== E4 200 字符徽章：199/200 不标红、201 标红；数字与实际一致 =====
    const e4 = await page.evaluate(() => {
      const mk = (n) => "甲".repeat(n); // 单字符（每个汉字 length=1）
      const task = { id: "e4", cardCopied: {} };
      const out = {};
      const cases = [199, 200, 201];
      for (const n of cases) {
        const row = railCardFieldRow(task, `e4:${n}`, CARD_FIELD_LABEL_TEXT.opening, mk(n));
        const badge = row.querySelector(".rc-badge");
        out[n] = {
          hasBadge: Boolean(badge),
          over: badge ? badge.classList.contains("over") : null,
          text: badge ? badge.textContent : null
        };
      }
      return out;
    });
    record("E4 199 字徽章存在且不标红", e4["199"].hasBadge && e4["199"].over === false, `text=${e4["199"].text}`);
    record("E4 200 字不标红（边界 >200）", e4["200"].over === false, `over=${e4["200"].over} text=${e4["200"].text}`);
    record("E4 201 字标红", e4["201"].over === true, `over=${e4["201"].over} text=${e4["201"].text}`);
    record("E4 徽章数字与字符数一致", e4["199"].text === "199 字" && e4["201"].text === "201 字");

    // ===== E5 引导文案：无 cards.md 时显示引导（missing 态） =====
    const e5 = await page.evaluate(() => {
      const task = { id: "e5", cardCopied: {} };
      railCardsState = { taskId: task.id, parsed: null, mtime: 0, missing: true, error: "" };
      renderRailCards(task);
      const guide = document.querySelector("#rail-cards .rc-guide");
      return { hasGuide: Boolean(guide), text: guide ? guide.textContent : "" };
    });
    record("E5 无 cards.md 显示引导文案", e5.hasGuide && /保存为 cards\.md/.test(e5.text), e5.text);

    // ===== E6 unparsed 展示：打乱段落进 unparsed 区，已解析卡片正常 =====
    const e6 = await page.evaluate(() => {
      const task = { id: "e6", cardCopied: {} };
      railCardsState = { taskId: task.id, parsed: window.__e2eParsed, mtime: 3, missing: false, error: "" };
      renderRailCards(task);
      const unparsedWrap = document.querySelector("#rail-cards .rc-unparsed");
      const pres = unparsedWrap ? [...unparsedWrap.querySelectorAll("pre")].map((p) => p.textContent) : [];
      const cards = document.querySelectorAll("#rail-cards .rc-card").length;
      return {
        hasUnparsed: Boolean(unparsedWrap),
        unparsedHasGarble: pres.some((t) => /被故意打乱格式/.test(t)),
        parsedCardCount: cards,
        parsedCardsExpected: window.__e2eParsed.cards.length
      };
    });
    record("E6 unparsed 区存在并展示打乱原文", e6.hasUnparsed && e6.unparsedHasGarble);
    record("E6 已解析卡片不受影响（数量一致）", e6.parsedCardCount === e6.parsedCardsExpected, `渲染${e6.parsedCardCount}/解析${e6.parsedCardsExpected}`);

    await page.waitForTimeout(500);
    record("卡片舱 E2E 全程无 pageerror", pageErrors.length === 0, pageErrors.join(" | "));

  } catch (e) {
    record("卡片舱 E2E 执行", false, String(e && e.stack || e));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("\n===== 卡片舱 E2E 结果 =====");
  console.log(`总计 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? " — " + f.detail : ""}`);
    process.exit(1);
  } else {
    console.log("全部通过。");
    process.exit(0);
  }
})();
