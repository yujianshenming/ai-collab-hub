# Handoff: Codex -> Antigravity

## Date
2026-06-01 15:33

## Summary
Codex 已完成 Task-008 的核心重构实施：Hermes Agent 现在支持动态角色、导师/被动角色双模式、严格台词输出约束，并移除了旧的体育教师硬编码和 Antigravity 本机路径硬编码。

## Implemented
- `TaskAnalyzer.analyze_task()` 扩展了结构化元数据：`ai_role`、`dialogue_mode`、`transition_rule_desc`。
- `compile_card_prompt()` 改为接收 metadata，并按 `dialogue_mode` 生成两套模板：
  - `tutor`：导师/专家引导型，一次只问一个具体问题。
  - `passive`：患者/客户/谈判对手型，问什么答什么，不主动透露答案。
- 新增 `normalize_dialogue_output()`，用于清除 `<think>`、动作/神态描写，并限制普通台词长度。
- `PromptGenerator`、`AgentSandbox`、`HermesAgent.run()` 已贯通角色与模式元数据。
- `result_to_dict()` 增加返回 `ai_role`、`dialogue_mode`、`transition_rule_desc`，便于前端或调试查看分析结果。
- `server.py` 的调试输入保存目录改为 `HERMES_DEBUG_DIR` 环境变量或仓库本地 `debug/`，不再写死 Antigravity scratch 路径。
- mock fallback 和 mock transcript 已改为通用能力训练示例，避免残留“高中体育教师/体育教师”等固定场景。

## Verification
- `python -m compileall hermes_agent.py server.py` 通过。
- `rg -n "高中体育教师|高中体育|体育教师|学校体育学|体育学|P\\.E\\.|antigravity\\\\brain|7319f9a2|C:\\\\Users\\\\24391\\\\.gemini" hermes_agent.py server.py` 无匹配。
- `HERMES_FORCE_MOCK=1` 下直接运行 `HermesAgent().run(...)`，结果：
  - 返回 metadata：`ai_role=通用实训导师`、`dialogue_mode=tutor`、`transition_word=Next`。
  - transcript 未发现超 100 字台词。
  - transcript 未发现 `<think>`、`*...*`、括号动作描写。
  - 跳转输出为精确 `Next`，无标点或附加文字。

## Changed Files
- `hermes_agent.py`
- `server.py`
- `handoff/codex-to-antigravity.md`
- `status/current.md`

## Blockers
暂无。

## Requested Next Action
请 Antigravity 拉取后用真实医学问诊、商务谈判、工程导师三类文档各测一次，重点审查 `dialogue_mode` 是否能被稳定识别为 `passive` 或 `tutor`，以及真实模型输出是否仍能保持 100 字以内和精确跳转词。
