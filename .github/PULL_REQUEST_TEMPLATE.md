<!--
PR 模板 · 配套 CODE_REVIEW_PROCESS.md / CODE_REVIEW_STANDARD.md
AI 生成代码同样必须填完本模板，不豁免。
-->

## 变更类型与范围

- [ ] feat（新功能）
- [ ] fix（缺陷修复）
- [ ] refactor（重构）
- [ ] security（安全相关）
- [ ] test（测试）
- [ ] docs（文档）
- [ ] chore（构建/工具）

**改动文件**：（列出主要文件，如 `server.py`、`hermes_agent.py`、`personal-workbench/main.js`）

**一句话概述**：

---

## 关联任务

- 协作任务 / handoff：`handoff/xxx.md` 或 `tasks/active.md` 中条目
- 关联 issue / 决策：`decisions/...` 或 issue 链接

---

## 自审清单（作者合入前必勾）

- [ ] 本地质量门禁已通过（Python：`ruff` + `pytest`；前端：`npm run check` + `npm test`）
- [ ] 已对照审查标准五个维度自查（正确性 / 安全 / 可维护性 / 性能 / 测试）
- [ ] 没有把密钥、Cookie、Token、`weekly_tasks.json`、`llm-secret.bin`、个人路径提交进 git
- [ ] 破坏性改动已补/更新测试或回归证据

---

## 测试证据

<!-- 贴测试结果摘要或命令输出；若无法自动测，说明人工验证步骤 -->

```
（在此粘贴 pytest / npm test / 手动验证的关键输出）
```

---

## 安全影响（security / 任意涉及 IPC、Token、路径、上传下载的 PR 必填）

- [ ] 本 PR 不涉及安全边界
- [ ] 涉及安全边界，已对照 `personal-workbench/regression-checklist.md` §6 / §7.2 自检
- [ ] 已补充安全回归测试 / 证据（说明在哪）

**安全自查结论**：（如"普通外网 webview 仍拿不到完整 token"、"temp/tasks IPC 拒绝越界路径"等）

---

## 风险与回滚

- **主要风险**：
- **回滚方式**：（如 revert commit / 该 PR 可安全 squash 回退 / 配置开关关闭）

---

## 给 Reviewer 的提示

<!-- 需要重点看的地方、设计取舍、已知遗留项（可链接 issue） -->
