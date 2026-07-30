# 代码审查流程（Code Review Process）

> 配套：[CODE_REVIEW_STANDARD.md](CODE_REVIEW_STANDARD.md)（查什么）、[../.github/PULL_REQUEST_TEMPLATE.md](../../.github/PULL_REQUEST_TEMPLATE.md)（PR 模板）。
> 最近更新：2026-07-30。

本流程把"代码审查标准"变成**可执行的步骤 + 强制门禁**。它直接挂靠现有 `PROTOCOL.md` 的多 AI 协作分工，不另立一套沟通渠道。

---

## 1. 角色与分工

| 角色 | 由谁担任 | 审查职责 |
|------|----------|----------|
| **Author（作者）** | Codex 或人类开发者 | 写代码、自审、填 PR 模板、回应意见、合入后更新状态 |
| **Reviewer（评审人）** | Antigravity，或指定人类/另一 agent | 按标准逐条审查、给级别标记、决定是否批准 |
| **Security Sign-off（安全复核）** | 涉及安全边界变更时追加 | 核对 `regression-checklist.md` §6 / §7.2，签字式确认 |

> 对齐 `PROTOCOL.md`：Antigravity 本就负责"审查 Codex 的执行结果"，本流程将其规范化。涉及安全四项的 PR，**必须**有安全复核，否则不得合入。

---

## 2. 触发时机

- **所有**合入 `master` 的变更都必须走 PR + 审查（含 AI 生成代码，不豁免）。
- 多机器同步（生活电脑 ↔ 工作电脑）的变更，同样以 PR 为单位合入，不在本地直接 push 到 `master` 主干逻辑分支之外长期漂移。
- 紧急 hotfix 可先合后补审查，但**必须在 24h 内**补全 PR 与审查记录，并在 `status/current.md` 标注。

---

## 3. 标准流程（七步）

```
① 自审  →  ② 开 PR（填模板）  →  ③ CI 门禁（lint+test 必须绿）
   →  ④ 人工评审（≥1 批准）  →  ⑤ 处理意见  →  ⑥ 合入（squash）
   →  ⑦ 记录（更新 status/handoff/artifacts）
```

### ① 自审（作者先做）
合入前作者自行过一遍：
- 跑本地质量门禁（Python：`ruff` + `pytest`；前端：`npm run check` + `npm test`）。
- 对照 [CODE_REVIEW_STANDARD.md](CODE_REVIEW_STANDARD.md) 五个维度自查。
- 确认没有把密钥/个人数据塞进 git（见 `AGENTS.md`）。

### ② 开 PR + 填模板
使用 `.github/PULL_REQUEST_TEMPLATE.md`，重点填：**变更类型/范围、关联任务（handoff/issue 链接）、自审结果、测试证据、安全影响、风险与回滚**。

### ③ CI 门禁（自动）
`.github/workflows/ci.yml` 在每次 PR 自动跑：
- Python：`ruff check`（lint）+ `pytest`（测试）+ 关键脚本 `py_compile`。
- 前端：`npm run check` + `npm test`（含 `regression-checklist.md` §7.1 契约测试）。
- **CI 不绿，PR 不得合入**（阶段 2 起设为 branch protection 必需检查）。

### ④ 人工评审
- 至少 **1 个 Approval**（来自 Reviewer：Antigravity 或人类）。
- 安全相关 PR 需额外 **Security Sign-off**。
- Reviewer 按标准给每条意见打 🔴/🟡/💭 标记，并用统一注释格式（见标准 §7）。

### ⑤ 处理意见
- 🔴：必须修复并回复"已修复 + 如何验证"；修复后 Reviewer 复核。
- 🟡：修复，或书面说明理由并建 issue 跟踪后合入。
- 💭：可延后，建议建 issue 或顺手修。
- **禁止**无理由 Dismiss reviewer 意见；有分歧走 §5 升级机制。

### ⑥ 合入
- 推荐 **squash merge**，commit message 采用约定式（`feat:`/`fix:`/`refactor:`/`security:`/`test:`）。
- 合入即触发 CI 在主分支再跑一次。

### ⑦ 记录
- 更新 `status/current.md`（当前目标/进展/下一步）。
- 若源于协作任务，更新对应 `handoff/` 文件。
- 重大设计取舍写入 `decisions/`。
- 审查中发现的可复用结论，可沉淀进 `artifacts/reviews/` 或回填标准 §5 案例表。

---

## 4. SLA 与最低要求（建议值，可按团队调整）

| 项 | 建议 |
|----|------|
| 首响时间 | ≤ 1 个工作日 |
| 完整评审 | ≤ 2 个工作日（小 PR ≤100 行可当天） |
| 必需批准数 | 普通 1；安全相关 1 + Security Sign-off |
| 小 PR 优先 | ≤100 行的纯修复/文档 PR 走快速通道 |
| 打回重审 | 作者修完后 1 个工作日内复核 |

> 这些数值是**起点建议**，请在 `decisions/` 里确认最终值；本文件只给默认。

---

## 5. 如何处理分歧

1. Author 与 Reviewer 对某条意见不一致 → 在 PR 下讨论，各自给理由。
2. 仍僵持 → 升级给 **Antigravity**（方案层面）或 **用户**（业务层面）裁决，不阻塞其他无关 PR。
3. 涉及安全边界 → 以 `regression-checklist.md` 与标准 §6 红线为准，Reviewer 有**一票否决权**。

---

## 6. 质量门禁工具（强制化）

详见 `.github/workflows/ci.yml` 与根 `pyproject.toml`：

- **Python**：`ruff`（lint）+ `pytest`（测试）。当前 Python 侧**零测试**，阶段 1 优先补 `hermes_agent.py` 纯函数单测与 `/api/start-harness` 集成测试。
- **前端**：复用现有 `npm run check` + `npm test`，CI 直接调用，无需新增框架。
- **渐进策略**：上线首月 `ruff` 设为**非阻塞**（仅报告），待存量问题清理后再转阻塞，避免第一天全红劝退。

---

## 7. 与现有协作协议衔接

- 本流程是 `PROTOCOL.md` "Antigravity 审查 Codex 执行结果" 的细化，复用其 handoff / status / decisions 机制，**不新增沟通载体**。
- 前端安全回归以 `personal-workbench/regression-checklist.md` 为权威，本流程 §3③ 的 CI 已覆盖其 §7.1 契约测试。
- 维护纪律遵循 `personal-workbench/AGENTS.md`（改前读手册、补测试、跑 `test:all`、不提交个人数据）。

---

## 8. 落地路线图（分阶段）

| 阶段 | 时间 | 目标 | 完成标志 |
|------|------|------|----------|
| **0 立规** | 本周 | 发布标准+流程+PR 模板，团队对齐严重级别 | 三份文档合入 `master`，`decisions/` 记录采纳 |
| **1 补测试** | 2 周内 | Python 侧补最小可行测试 + 引入 `ruff`；前端 CI 跑通 | `pytest` 有 ≥1 个通过的纯函数测试；CI 在 PR 上出报告 |
| **2 强制门禁** | 1 月内 | `master` 设 branch protection，CI 必需 + 1 批准；安全 PR 强制双人复核 | 空 PR 无法合入；安全项缺 Sign-off 被拦 |
| **3 持续回顾** | 每月 | 复盘评审数据（🔴/🟡 分布、最长评审时长）、清 §5 案例、调标准 | 月度记录进 `artifacts/reviews/`；标准修订一版 |

---

## 9. 一页速查（贴墙版）

- 改代码前：读 `AGENTS.md` / `PROJECT_HANDBOOK.md` / 相关测试。
- 提 PR 前：本地跑门禁 + 自审五维度 + 填模板。
- 审 PR 时：每条意见带 🔴/🟡/💭 + 位置 + 为什么 + 建议；好代码写 👍。
- 红线（§6）：密钥泄露、路径穿越、未鉴权 API、外网拿全 token、破坏 IPC/DOM 一致性、盲信 LLM 输出 → 直接打回。
- 合入后：更新 `status` / `handoff` / `decisions`，安全项留回归证据。
