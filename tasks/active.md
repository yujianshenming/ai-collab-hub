# Active Tasks

进行中的任务。

* [ ] **V3.4 收尾**：补真机上传验证（P1 #2）并整理 `codex/personal-workbench` 合入 `master`。
  - Owner: 测试工程师（真机验证）→ Codex（合入准备）
  - 依据：`../personal-workbench-v3.4-spec.md`、`../personal-workbench/regression-checklist.md`

* [ ] **确认剩余 1 个主线闭环点**（影响上传链路）：
  - #2 `select-file-dialog` 旧链路已废弃，现改用 CDP `Page.fileChooserOpened` + `DOM.setFileInputFiles` + 系统选择器 fallback；机制已修，待真机确认。
  - Owner: Codex / 测试工程师

* [ ] **V3.5 规划（优先方向）**：增强任务、文件、页面、报告之间的协作，建设强辅助工作台。
  - Owner: 产品经理（规格书）
  - 状态：待 P1 #2 人工验证与主线状态对齐后启动
  - 说明：不追求全自动填卡；自动化只作为辅助能力服务任务闭环
