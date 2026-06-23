# Active Tasks

进行中的任务。

* [ ] **V3.4 收尾**：回归验收平台填写助手（卡片舱），通过后将 `codex/personal-workbench` 合入 `master`。
  - Owner: 测试工程师（回归）→ Codex（合入）
  - 依据：`../personal-workbench-v3.4-spec.md`、`../personal-workbench/regression-checklist.md`

* [ ] **优先清理 2 个 P1 缺陷**（影响 Hermes 流程与上传）：
  - #1 `findTabByUrlPart` 对无 url 标签抛 TypeError（renderer.js:1938）。
  - #2 `select-file-dialog` 在 Electron 36 可能不存在，上传注入或未生效（renderer.js:1842，待真机确认）。
  - Owner: Codex

* [ ] **V3.5 规划（候选）**：平台全自动填卡、提示词自动归位、任务文档快速归档。
  - Owner: 产品经理（规格书）
  - 状态：构想中，待 V3.4 验收与 P1 修复后启动
