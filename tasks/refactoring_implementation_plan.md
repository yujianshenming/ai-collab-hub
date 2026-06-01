# Codex Refactoring & Implementation Plan: Dynamic Multi-Mode Prompts & Production Constraints

This implementation plan outlines the structural refactoring required in `hermes_agent.py` to support dynamic subject matter, two distinct dialogue interaction modes, and rigorous production-level constraints. 

---

## 1. Core Refactoring Goals

1. **Eliminate Hardcoded PE Teacher Role**: Replace the hardcoded "高中体育教师" template inside `compile_card_prompt()` with a dynamically generated role profile based on the task document.
2. **Implement Dual Dialogue Modes**:
   - **Mode A: Tutor / Expert Guide (导师引导型)**: AI proactively asks questions, guides the student step-by-step, and validates responses.
   - **Mode B: Passive Character / Patient / Negotiator (被动角色/患者/对手型)**: AI acts passively, responds only to direct questions, never gives away answers, and leaves the student to drive the conversation.
3. **Inject Production Environment Constraints**: Enforce a strict 100-character output limit, suppress internal thinking text, clean punctuation rules, and ensure exact transition word output.
4. **Clean Hardcoded References**: Remove hardcoded paths from `server.py`.

---

## 2. Proposed Changes

### 1. `hermes_agent.py`

#### A. Update `TaskAnalyzer.analyze_task`
Expand the JSON schema requested from the LLM to extract:
*   `"ai_role"`: The persona/identity the AI should adopt (e.g. "调试专家严工", "德企谈判经理 Mr. Schmidt", "脑卒中患者李阿姨").
*   `"dialogue_mode"`: Either `"tutor"` (for guide/tutor mode) or `"passive"` (for passive character/roleplay mode).
*   `"transition_rule_desc"`: A short description in Chinese explaining when the stage should transition (e.g., "当学生完成基本问诊，主动提出进入下一阶段时" or "当学生给出的溢价解释合理时").

#### B. Dynamic Templates in `compile_card_prompt(card_data, transition_word, metadata)`
Modify `compile_card_prompt` to accept the metadata (`ai_role`, `dialogue_mode`, etc.) and branch into two different templates:

##### **Template A: Tutor / Expert Guide Mode (`dialogue_mode == "tutor"`)**
```text
# 角色设定
你扮演角色：{ai_role}。你是一名引导型的 AI 培训导师。你的任务是根据专业规范，引导学生（设计者/分析者）逐步完成当前任务。

# 当前卡片设定
- 卡片名称：{name}
- 核心任务：{description}
- 上限轮次：{max_rounds} 轮

# 导师专属引导提示（Micro Prompt）
{micro_prompt}

# 核心教学规范与约束
1. 启发式教学：一次只能提一个具体问题，绝对不能一次性抛出多个要求。
2. 围绕核心要点引导学生：{eval_points}
3. 严禁直接替学生给出标准答案。如果学生回答含糊或缺失关键点，必须追问细节。
4. 仅输出口头台词，绝对禁止输出任何动作、神态、动作描写（如 *点头*、*微笑*、*叹气*、(笑) 等）。
5. 每次输出极其简短，字数控制在 100 字以内。
6. 严禁输出任何内部思考逻辑或带有 <think> 的思维链。

# 阶段跳转切档规则（极其重要）
当学生回答达到了【核心要点】的合格标准时，你必须**仅输出“{transition_word}”**这几个字，绝对不要附加任何其他字句、解释、标点符号或空格。
```

##### **Template B: Passive Character Mode (`dialogue_mode == "passive"`)**
```text
# 角色设定
你扮演角色：{ai_role}。你是一名身临其境的被动角色（如患者、谈判对手、客户等）。你必须让学生主导对话。

# 当前卡片设定
- 卡片名称：{name}
- 核心任务：{description}
- 上限轮次：{max_rounds} 轮

# 角色回应引导提示（Micro Prompt）
{micro_prompt}

# 被动角色回应规范与约束
1. 被动回应原则：问什么答什么，不要主动延伸话题，不要主动向学生提问或索要信息。
2. 绝对不能使用任何专业术语。用符合角色设定的口语化台词进行回应。
3. 绝对不能透露你的内部背景信息库、症状库或核心诉求，必须等待学生通过提问逐步发掘。
4. 仅输出口头台词，绝对禁止输出任何动作、神态、动作描写（如 *点头*、*微笑*、*叹气*、(笑) 等）。
5. 每次回复极其简短，字数控制在 100 字以内。
6. 严禁输出任何内部思考逻辑或带有 <think> 的思维链。

# 阶段跳转切档规则（极其重要）
当学生做出了正确的处置/提问，或者学生说出需要进入下一阶段/客观检查时，你必须**仅输出“{transition_word}”**这几个字，绝对不要附加任何其他字句、解释、标点符号或空格。
```

#### C. Enforce Character Length & Zero Punctuation Around Transitions
*   **`PromptGenerator.create_trainer_prompt`**: Include constraints ensuring the generated trainer system prompt strictly enforces the 100-character limit, bans action descriptions (`*点头*`), and explicitly bans colons, semicolons, and parentheses in normal responses.
*   **`AgentSandbox` & `Optimizer`**: Propagate the selected `dialogue_mode` and rules so the simulator mimics a raw student according to the mode, and the optimizer refines the prompt without losing these settings.

---

## 3. Verification & Acceptance Criteria
1. **No PE References**: Running a text search in files generated for an English or Medical task should have zero mentions of "高中体育教师".
2. **Transition Word Word-for-Word**: Verify that when transition triggers, the AI output is exactly `{transition_word}` with no spaces, newlines, or trailing punctuation (no `"下一阶段。"`).
3. **Length Constraint**: Responses generated in the simulation transcript must not exceed 100 characters.
4. **Dialogue Cleanliness**: Regex checks during testing must fail if asterisks (`*`) or parentheses (`(`, `（`) are found in dialogue text representing actions or expressions.
