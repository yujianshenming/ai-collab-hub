# Handoff: Codex -> Antigravity

## Date
2026-06-01 16:30

## Summary
已根据你们最新测试反馈完成二次增强：去除提示词长度上限、增加强约束规则（不丢规则、不空行、自适应提问、偏题拉回、图片上传提醒、禁止内部思路）、修复被动模式首轮发言顺序，并支持按卡片独立跳转词。

## Implemented
- `TaskAnalyzer` 的卡片 schema 增加可选 `card.transition_word`，缺省自动回退到根级 `transition_word`。
- `AgentSandbox.simulate()` 切档检测改为按“当前卡片跳转词”判定，不再强依赖全局单词。
- 被动模式 `passive` 首轮改为学生先发起，Trainer 被动应答，避免患者/对手主动引导。
- `compile_card_prompt()` 两套模板新增硬规则：
  - 规则不可弱化：不允许减少关键约束。
  - 禁止空行，回复连续输出。
  - 严禁内部思路与 `<think>`。
  - 学生偏离角色时提醒回到角色与场景。
  - 学生问非本阶段内容时引导回本阶段。
  - 除非任务文档写死问题，否则不要固定问句模板，必须按学生回答自适应追问。
  - 图片由平台人工上传，AI 需主动提示“请上传对应图片资源”并继续文字引导。
- `normalize_dialogue_output()` 新增空行压缩与行清洗，确保输出连续。
- 去除提示词长度上限相关限制：
  - 移除 `create_trainer_prompt` 中“strictly under 300 characters”约束。
  - 移除 `Optimizer.refine` 中 300 字精简要求。
  - 系统提示返回截断阈值改为大上限（避免实际截断）。

## Verification
- `python -m compileall hermes_agent.py` 通过。
- mock 验证：
  - `passive` 模式首条发言为 `Student`。
  - 卡片独立跳转词可被准确触发（示例：`准备就绪`、`现象确认`）。
  - 对话中无 `<think>`，无空行插入。

## Changed Files
- `hermes_agent.py`
- `handoff/codex-to-antigravity.md`
- `status/current.md`

## Blockers
暂无。

## Requested Next Action
请使用你们刚测试的同一批真实任务文档复测三点：1) 是否仍会出现“规则被缩写”现象；2) 被动模式首轮是否稳定由学生发起；3) 多卡片不同跳转词是否都能稳定切档。
