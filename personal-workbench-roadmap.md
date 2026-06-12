# 个人工作台 总任务大纲与版本路线图

> 产品经理维护 · 2026-06-11
> 配套规格书索引见 §4；用户工作流原始记录见共享记忆 `personal-workbench-user-workflow`

---

## 1. 产品愿景

把用户的全部工作入口集合进一个桌面工作台：10+ 常驻浏览器页面、企业微信、Codex / Antigravity / Cursor、终端 Claude Code、多个文件夹与 txt/word 文档。**打开工作台 = 完成全部工作，不再开额外的应用。**

技术载体：Electron 应用 `personal-workbench/`（常驻 webview 标签 + 本地 PowerShell 终端 + 任务流水线 + 文件总线）。

## 2. 用户端到端工作流（10 步）

1. 企业微信查看本周任务 → 手动整合到桌面「待做任务.txt」
2. 按任务找对应人拿任务文档 → 放入对应文件夹
3. 打开浏览器固定页面 + 启动 Hermes
4. 任务文档发给 Hermes → 分阶段 → 审核 → 逐阶段写提示词
5. 把产出逐字段填到公司平台（卡片名称/建议轮次/阶段描述/开场白/提示词）
6. 并行用豆包生成封面图 → 裁切底部约 100px 去水印 → 填到平台
7. 填写评价标准
8. 浏览器插件测试 → 下载测试对话 → 与任务文档一起上传评估页
9. 不通过 → 下载评估报告，连同测试对话给 Hermes 修改 → 循环直到通过
10. 通过 → 提示词保存到对应位置 → 任务完成

### 流程覆盖度地图

| 环节 | 工作台能力 | 覆盖 |
|---|---|:---:|
| ① 任务清单 | V3.2 导入 + V3.3 写回 | 🟡→✅ |
| ② 文档归档 | 任务专属文件夹（手动放入） | 🟡 |
| ③ 固定页面 + Hermes | 常驻 webview，登录态不丢 | ✅ |
| ④ Hermes 分阶段 | 产物路径一键注入 | ✅ |
| ⑤⑦ 填平台字段 | V3.4 卡片舱 → V3.5 自动注入 | ❌→🔵 |
| ⑥ 封面图裁切 | V3.1 托盘一键裁切 | ✅ |
| ⑧ 测试→评估 | 文件总线（V3.3 修复可靠性） | 🟡→✅ |
| ⑨ 报告→Hermes 循环 | 流水线捕获 + 注入 | ✅ |
| ⑩ 提示词归位 | 待规划（V3.5 候选） | ❌ |

## 3. 版本路线图

| 版本 | 主题 | 状态 |
|---|---|---|
| V3（Phase 1-2） | 任务驱动 UI、任务舱、流水线五步模型 | ✅ 已交付 |
| V3.1 | 文件总线：全局下载捕获、任务文件托盘、上传注入、裁切去水印 | ✅ 已交付 |
| V3.2 | 任务源头：待做任务.txt 解析导入、未提交状态、子任务进度 | ✅ 验收通过 |
| V3.3 | 文件总线可靠性（6 缺陷清零，含上传拦截 CDP 重做）+ 任务状态写回 txt | 🔵 开发完成，验证中 |
| V3.4 | 平台填写助手：cards.md 解析、卡片舱逐字段一键复制、平台表单注入勘测 | 📄 规格书就绪，待派发 |
| V3.5（候选） | 平台全自动填卡（视 V3.4 勘测结论）、提示词自动归位、任务文档快速归档 | 💭 构想 |

## 4. 规格书索引

| 文档 | 版本 | 轮次 |
|---|---|---|
| `personal-workbench-plan.md` | 初版重构 | — |
| `personal-workbench-automation-plan.md` | 任务工作流与蓝线修复 | Round 4 |
| `personal-workbench-ui-redesign-spec.md` | 任务驱动 UI 重设计 | Round 5 |
| `personal-workbench-file-bus-spec.md` | V3.1 文件总线 | Round 6 |
| `personal-workbench-task-import-spec.md` | V3.2 任务源头 | Round 7 |
| `personal-workbench-v3.3-spec.md` | V3.3 可靠性 + 写回 | Round 8 |
| `personal-workbench-v3.4-spec.md` | V3.4 平台填写助手 | Round 9 |
| `personal-workbench/regression-checklist.md` | 回归测试清单（测试工程师维护） | 持续更新 |

## 5. 交付纪律（团队约定）

- 以 `personal-workbench/` 为唯一主线，旧工作台（根目录 index.html/server.py/static）已废弃
- 流程：工程师完成代码 → `npm run check` + 必要测试 → 测试工程师验证 → PM 验收 → 推送 GitHub
- `master` 只收验收通过的代码；开发在 `codex/personal-workbench` 分支进行
- 每轮规格书都包含「范围外」清单，防 scope 膨胀；缺陷以回归清单附表登记编号
