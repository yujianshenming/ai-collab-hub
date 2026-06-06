from __future__ import annotations

import json
import os
import random
import re
import textwrap
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config.json"
MAX_TASK_DOCUMENT_CHARS = 4000


@dataclass
class ChatTurn:
    speaker: str
    role: str
    content: str


@dataclass
class Evaluation:
    score: int
    dimensions: dict[str, int]
    diagnosis: list[str]
    recommendations: list[str]


@dataclass
class HarnessRound:
    round_number: int
    trainer_prompt: str
    student_prompt: str
    transcript: list[ChatTurn]
    evaluation: Evaluation
    refined: bool = False


@dataclass
class HarnessResult:
    task_summary: str
    provider: str
    started_at: str
    threshold: int
    school: str = ""
    course: str = ""
    task_type: str = ""
    cards: list[dict[str, Any]] = field(default_factory=list)
    evaluation_criteria: list[str] = field(default_factory=list)
    student_persona: str = ""
    rounds: list[HarnessRound] = field(default_factory=list)
    final_prompt: str = ""
    status: str = "completed"
    transition_word: str = ""
    ai_role: str = ""
    dialogue_mode: str = "tutor"
    transition_rule_desc: str = ""


class OpenAICompatibleClient:
    def __init__(self, config_path: Path = CONFIG_PATH) -> None:
        self.config = self._load_config(config_path)
        self.force_mock = os.getenv("HERMES_FORCE_MOCK", "").lower() in {"1", "true", "yes"}

    @property
    def provider(self) -> str:
        if self.config and not self.force_mock:
            return f"openai-compatible:{self.config.get('model', 'unknown')}"
        return "mock"

    def _load_config(self, config_path: Path) -> dict[str, str]:
        if not config_path.exists():
            return {}
        with config_path.open("r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
        required = {"api_key", "base_url", "model"}
        missing = required.difference(data)
        if missing:
            raise ValueError(f"config.json is missing keys: {', '.join(sorted(missing))}")
        return data

    def chat(self, messages: list[dict[str, str]], temperature: float = 0.35) -> str:
        if not self.config or self.force_mock:
            return self._mock_response(messages)

        url = self.config["base_url"].rstrip("/") + "/chat/completions"
        payload = {
            "model": self.config["model"],
            "messages": messages,
            "temperature": temperature,
        }
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.config['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = json.loads(response.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
        except Exception as exc:
            print(f"[API Warning] Call failed: {exc}. Switching to mock fallback.")
            self.force_mock = True
            return self._mock_response(messages)

    def _mock_response(self, messages: list[dict[str, str]]) -> str:
        last = messages[-1]["content"] if messages else ""
        return "模拟的 Hermes 助手回答: " + summarize_document(last, 220)


class TaskAnalyzer:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def analyze_task(self, task_document: str, transition_word: str = "下个阶段") -> dict[str, Any]:
        truncated_doc = (task_document or "")[:4000]

        if self.llm.provider == "mock" or not truncated_doc:
            return {
                "school": "测试学校",
                "course": "通用能力训练",
                "task_type": "综合实训",
                "transition_word": transition_word,
                "ai_role": "通用实训导师",
                "dialogue_mode": "tutor",
                "transition_rule_desc": "当学生完成当前阶段核心任务并可进入下一阶段时",
                "cards": [
                    {
                        "stage_number": 1,
                        "name": "阶段一：任务理解",
                        "max_rounds": 6,
                        "transition_word": transition_word,
                        "description": "引导学生明确任务背景与目标",
                        "opening": "你好，我们先明确任务背景。你认为当前最重要的问题是什么？",
                        "evaluation_points": "学生必须说明任务背景、核心问题和目标对象。",
                        "prompt": f"引导学生完成任务理解。重点考察背景、问题与目标对象。合格后仅输出“{transition_word}”。"
                    },
                    {
                        "stage_number": 2,
                        "name": "阶段二：方案制定",
                        "max_rounds": 6,
                        "transition_word": transition_word,
                        "description": "引导学生提出可执行方案",
                        "opening": "很好，接下来请提出一个可执行方案。你会先做哪一步？",
                        "evaluation_points": "学生必须给出步骤、依据和关键资源安排。",
                        "prompt": f"引导学生制定方案。重点考察步骤、依据和资源安排。合格后仅输出“{transition_word}”。"
                    },
                    {
                        "stage_number": 3,
                        "name": "阶段三：复盘总结",
                        "max_rounds": 6,
                        "transition_word": transition_word,
                        "description": "引导学生总结成果与风险",
                        "opening": "最后请复盘你的方案。你认为成果和风险分别是什么？",
                        "evaluation_points": "学生必须总结成果、风险和后续改进方向。",
                        "prompt": "引导学生总结成果、风险和改进方向。完成后输出跳转词。"
                    }
                ],
                "evaluation_criteria": [
                    "任务理解准确",
                    "方案步骤可执行",
                    "复盘总结有依据"
                ],
                "student_persona": "注意力分散的初学者，偏好简单回答，跑题但顺从。"
            }

        system_msg = textwrap.dedent(
            f"""
            You are a pedagogical design and prompt engineering expert. Analyze the provided task document in Chinese and output a complete training plan structure in JSON format.
            The JSON object must contain exactly the following keys:
            {{
              "school": "Automatically extract the school name or default to '高中'",
              "course": "Automatically extract the course name or default to '通用课程'",
              "task_type": "Extract the task type (e.g. 实训/作业/课程设计)",
              "transition_word": "The exact transition word/phrase to trigger switching stages (e.g., '下一阶段', '下一板块', 'Next', '训练结束'), extracted from the task document if specified, otherwise default to '{transition_word}'",
              "ai_role": "The persona/identity the AI trainer or roleplayer should adopt, extracted from the document (e.g., 调试专家严工, 脑卒中患者李阿姨, 德企谈判经理 Mr. Schmidt)",
              "dialogue_mode": "Choose exactly one value: 'tutor' for expert/teacher guided tasks, or 'passive' for patient/client/negotiator roleplay tasks where the student drives the dialogue",
              "transition_rule_desc": "Short Chinese description of when to output the exact transition_word",
              "cards": [
                {{
                  "stage_number": 1,
                  "name": "Card name in Chinese (e.g., 阶段一：体能恢复与评估)",
                  "max_rounds": <integer suggested rounds, between 4 and 6 depending on complexity>,
                  "transition_word": "Optional per-card transition word. If omitted, fallback to root transition_word.",
                  "description": "Stage description in Chinese (under 40 chars)",
                  "opening": "First greeting question from the Trainer to start this stage in Chinese (under 50 chars)",
                  "evaluation_points": "Specific criteria for the student's answer in this stage (e.g., must list 3 games and grouping rules) in Chinese (under 60 chars)",
                  "prompt": "Trainer guide system prompt for this stage in Chinese, instructing how to guide and when to transition (output the exact transition_word specified at the root of the JSON)."
                }},
                ...
              ],
              "evaluation_criteria": [
                "Evaluation criterion 1 in Chinese (under 30 chars)",
                "Evaluation criterion 2 in Chinese"
              ],
              "student_persona": "Custom student persona description for simulation based on common learning difficulties (under 40 chars) in Chinese"
            }}
            Ensure that for each card, the Trainer prompt instructs the trainer to ONLY output the transition word (the same string as in the 'transition_word' key of this JSON, absolutely nothing else) when the student achieves that card's goals.
            Respond ONLY with the raw JSON object. Do not include markdown wraps like ```json.
            """
        ).strip()

        res = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": f"Task Document:\n{truncated_doc}"}
        ])

        try:
            cleaned = res.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1]
            if cleaned.endswith("```"):
                cleaned = cleaned.rsplit("\n", 1)[0]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
            
            data = json.loads(cleaned.strip())
            if "transition_word" not in data:
                data["transition_word"] = transition_word
            data.setdefault("ai_role", "通用实训导师")
            if data.get("dialogue_mode") not in {"tutor", "passive"}:
                data["dialogue_mode"] = "tutor"
            data.setdefault("transition_rule_desc", "当学生完成当前阶段核心目标时")
            required_keys = {"school", "course", "task_type", "cards", "evaluation_criteria", "student_persona"}
            if not required_keys.issubset(data):
                raise ValueError("Missing required JSON keys")
            for card in data.get("cards", []):
                if not card.get("transition_word"):
                    card["transition_word"] = data["transition_word"]
            return data
        except Exception as exc:
            print(f"[API Warning] Dynamic task analysis failed: {exc}. Using default fallback.")
            self.llm.force_mock = True
            return self.analyze_task(None, transition_word=transition_word)


def normalize_dialogue_output(text: str, transition_word: str | None = None, limit: int = 100) -> str:
    cleaned = re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL | re.IGNORECASE).strip()
    cleaned = re.sub(r"[*＊][^*＊]{0,40}[*＊]", "", cleaned).strip()
    cleaned = re.sub(r"[（(][^（）()]{0,30}(?:笑|微笑|点头|叹气|沉默|思考|皱眉|停顿|动作|表情)[^（）()]{0,30}[）)]", "", cleaned).strip()
    cleaned = re.sub(r"\r?\n\s*\r?\n+", "\n", cleaned)
    cleaned = "\n".join(line.strip() for line in cleaned.splitlines() if line.strip())
    if transition_word:
        compact = cleaned.strip().strip("。.!！?？；;：:，,、 \t\r\n")
        if compact == transition_word:
            return transition_word
    if len(cleaned) > limit:
        cleaned = cleaned[:limit].rstrip()
    return cleaned


def get_card_transition_word(card_data: dict[str, Any], default_transition_word: str) -> str:
    candidate = str(card_data.get("transition_word", "")).strip()
    return candidate or default_transition_word


def compile_card_prompt(card_data: dict[str, Any], transition_word: str, metadata: dict[str, Any] | None = None) -> str:
    name = card_data.get("name", "未命名阶段")
    description = card_data.get("description", "设计本阶段任务")
    max_rounds = card_data.get("max_rounds", 4)
    eval_points = card_data.get("evaluation_points", "设计合理的教学内容与方法")
    micro_prompt = card_data.get("prompt", "引导学生完成本阶段设计")
    card_transition_word = get_card_transition_word(card_data, transition_word)
    metadata = metadata or {}
    ai_role = metadata.get("ai_role") or "通用实训导师"
    dialogue_mode = metadata.get("dialogue_mode") or "tutor"
    transition_rule_desc = metadata.get("transition_rule_desc") or "当学生完成本阶段核心目标时"

    if dialogue_mode == "passive":
        template = f"""# 角色设定
你扮演角色：{ai_role}。你是一名身临其境的被动角色。你必须让学生主导对话。

# 当前卡片设定
- 卡片名称：{name}
- 核心任务：{description}
- 上限轮次：{max_rounds} 轮

# 角色回应引导提示（Micro Prompt）
{micro_prompt}

# 被动角色回应规范与约束
1. 被动回应原则：问什么答什么，不要主动延伸话题，不要主动向学生提问或索要信息。
2. 绝对不能使用超出角色身份的专业术语，必须使用符合角色设定的口语化台词。
3. 绝对不能透露内部背景信息库、症状库或核心诉求，必须等待学生通过提问逐步发掘。
4. 仅输出口头台词，绝对禁止输出任何动作、神态、动作描写（如 *点头*、*微笑*、*叹气*、(笑) 等）。
5. 每次输出极其简短，字数控制在 100 字以内。
6. 严禁输出任何内部思考逻辑或带有 <think> 的思维链。
7. 普通回应中避免冒号、分号和括号。
8. 禁止在回复中出现空行，每条回复内容连续输出，不得插入空白行。
9. 图片资源由平台人工上传。你需要在需要图示时主动提示“请上传对应图片资源”，并继续文字引导，不得假装已看到图片。
10. 学生偏离当前角色或任务边界时，先温和提醒其回到角色与场景，再继续本阶段互动。
11. 学生提问非本阶段内容时，先简短承接，再明确引导回本阶段目标，不展开跨阶段讲解。
12. 除非任务文档写死了固定问题，否则不要机械复读固定问句，应根据学生刚刚的回答做自适应回应。

# 阶段跳转切档规则（极其重要）
{transition_rule_desc}，你必须**仅输出“{card_transition_word}”**这几个字，绝对不要附加任何其他字句、解释、标点符号、换行或空格。
"""
        return template.strip()

    template = f"""# 角色设定
你扮演角色：{ai_role}。你是一名引导型的 AI 培训导师。你的任务是根据专业规范，引导学生逐步完成当前任务。

# 当前卡片设定
- 卡片名称：{name}
- 核心任务：{description}
- 上限轮次：{max_rounds} 轮

# 导师专属引导提示（Micro Prompt）
{micro_prompt}

# 核心教学规范与约束
1. 启发式教学：每轮最多一个核心问题，避免机械的一问一答；根据学生回答动态追问和调整引导策略。
2. 围绕核心要点引导学生：{eval_points}
3. 严禁直接替学生给出标准答案。如果学生回答含糊或缺失关键点，必须追问细节。
4. 如果学生偏离本阶段主题，温和引导其重回主线。
5. 仅输出口头台词，绝对禁止输出任何动作、神态、动作描写（如 *点头*、*微笑*、*叹气*、(笑) 等）。
6. 每次输出极其简短，字数控制在 100 字以内。
7. 严禁输出任何内部思考逻辑或带有 <think> 的思维链。
8. 普通回应中避免冒号、分号和括号。
9. 禁止在回复中出现空行，每条回复内容连续输出，不得插入空白行。
10. 图片资源由平台人工上传。涉及图示或证据图时，明确提醒学生上传对应图片，并基于已知文本继续指导。
11. 学生偏离角色或跑题时，先提醒角色定位与任务边界，再拉回当前阶段目标。
12. 学生提问非本阶段内容时，先简短回应，再引导回本阶段，不提前透出后续阶段答案。
13. 除非任务文档明确写死问题，否则不要使用固定问句模板；必须根据学生当前回答自适应出题与追问。

# 阶段跳转切档规则（极其重要）
{transition_rule_desc}，你必须**仅输出“{card_transition_word}”**这几个字，绝对不要附加任何其他字句、解释、标点符号、换行或空格。
"""
    return template.strip()


class PromptGenerator:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def create_trainer_prompt(
        self,
        task_document: str,
        cards: list[dict[str, Any]],
        transition_word: str = "下个阶段",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        truncated_doc = (task_document or "")[:4000]
        stages_text = "\n".join(
            f"- 阶段 {c['stage_number']}（{c['name']}）：{c['description']}（上限轮次: {c['max_rounds']}，切档词: {get_card_transition_word(c, transition_word)}）"
            for c in cards
        )
        metadata = metadata or {}
        ai_role = metadata.get("ai_role") or "通用实训导师"
        dialogue_mode = metadata.get("dialogue_mode") or "tutor"
        transition_rule_desc = metadata.get("transition_rule_desc") or "当学生完成当前阶段核心目标时"
        mode_desc = "被动角色，问什么答什么，不主动提问或透露答案" if dialogue_mode == "passive" else "导师引导，一次只问一个具体问题并逐步追问"

        if self.llm.provider == "mock":
            return textwrap.dedent(
                f"""
                你扮演：{ai_role}。模式：{mode_desc}。本次训练包含以下阶段：
                {stages_text}
                输出规范：
                - 普通回应必须少于 100 字。
                - 仅输出口头台词，严禁动作、神态、括号描写和 <think>。
                - 禁止空行，回复必须连续输出。
                - 普通回应避免冒号、分号和括号。
                - 重要规则：当你确认学生已完全达成当前阶段的目标、可进入下一阶段时，你必须且只能输出“{transition_word}”，绝对不要附带其他任何标点或文字。
                - 触发说明：{transition_rule_desc}。
                """
            ).strip()

        system_msg = (
            f"You are an expert prompt engineer. Your task is to write a complete System Prompt in Chinese "
            f"for an AI Trainer or roleplayer (called Hermes Trainer) based on the task document.\n"
            f"Role: {ai_role}\n"
            f"Dialogue mode: {dialogue_mode} ({mode_desc})\n"
            f"Transition rule: {transition_rule_desc}\n"
            f"The training program has the following stages:\n"
            f"{stages_text}\n"
            f"The prompt must instruct the Trainer to:\n"
            f"1. Follow the selected dialogue mode exactly: tutor mode asks one guiding question at a time; passive mode answers only what the student asks and never volunteers hidden information.\n"
            f"2. Keep every normal response under 100 Chinese characters.\n"
            f"3. CRITICAL RULE: The trainer should be adaptive, not rigid. Unless the task document has fixed required questions, do not repeat fixed question templates and instead respond based on the student's latest answer.\n"
            f"4. CRITICAL RULE: When the Trainer decides the student has achieved the current stage's objective and is ready to enter the next stage, "
            f"the Trainer MUST output ONLY the transition word '{transition_word}' and absolutely nothing else (no punctuation, no other words).\n"
            f"5. CRITICAL RULE: The Trainer must ONLY output dialogue, and strictly forbid including any actions, physical descriptions, or facial expressions (e.g., *点头*, (微笑)).\n"
            f"6. CRITICAL RULE: The Trainer must never output internal thinking or <think> content, and should avoid colons, semicolons, and parentheses in normal responses.\n"
            f"7. CRITICAL RULE: No blank lines in a single response.\n"
            f"8. CRITICAL RULE: If student asks non-current-stage content, briefly acknowledge then guide back to the current stage objective.\n"
            f"9. CRITICAL RULE: If image evidence is needed, explicitly ask the student to upload it on the platform, and continue guidance based on text context.\n"
            f"Respond ONLY with the prompt in Chinese. Do not include markdown block markers, intro, or outro."
        )
        result = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": f"Task Document:\n{truncated_doc}"}
        ])
        return normalize_dialogue_output(result.strip(), transition_word=None, limit=20000)


class AgentSandbox:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def create_student_prompt(self, requested_persona: str | None) -> str:
        if requested_persona and requested_persona != "auto":
            return requested_persona
        return random.choice(
            [
                "注意力分散的初学者，经常在回答中掺杂无关事宜，甚至跑题。",
                "积极的主动学习者，有一定基础理解但缺乏实操经验。",
                "持怀疑态度的务实学生，倾向于挑战模糊的说法并要求具体实例。",
            ]
        )

    def simulate(
        self,
        trainer_prompt: str,
        student_prompt: str,
        round_number: int,
        cards: list[dict[str, Any]],
        transition_word: str = "下个阶段",
        metadata: dict[str, Any] | None = None,
    ) -> list[ChatTurn]:
        metadata = metadata or {}
        dialogue_mode = metadata.get("dialogue_mode") or "tutor"
        ai_role = metadata.get("ai_role") or "通用实训导师"

        def stage_word(card: dict[str, Any]) -> str:
            return get_card_transition_word(card, transition_word)

        if self.llm.provider == "mock":
            # Detailed mock transcript to show realistic multi-stage dialogue flow
            turns = []
            first_word = stage_word(cards[0])
            if dialogue_mode == "passive":
                turns.append(ChatTurn("Student", "student", "你好，我想先了解当前情况。"))
                turns.append(ChatTurn("Trainer", "trainer", "你好，请问你想先了解哪一部分。"))
            else:
                turns.append(ChatTurn("Trainer", "trainer", normalize_dialogue_output(cards[0]["opening"], first_word)))
            turns.append(ChatTurn("Student", "student", "我觉得要先看清任务目标。"))
            turns.append(ChatTurn("Trainer", "trainer", "请再说清楚目标对象和核心问题。"))
            turns.append(ChatTurn("Student", "student", "对象是学习者，问题是步骤不够清楚。"))
            turns.append(ChatTurn("Trainer", "trainer", "很好。你会用什么标准判断理解到位？"))
            turns.append(ChatTurn("Student", "student", "看能否说出背景、问题和目标。"))
            turns.append(ChatTurn("Trainer", "trainer", first_word))
            turns.append(ChatTurn("System", "system", f"检测到跳转词“{first_word}”，即将自动进入下一阶段..."))
            
            if len(cards) > 1:
                second_word = stage_word(cards[1])
                turns.append(ChatTurn("Trainer", "trainer", normalize_dialogue_output(cards[1]["opening"], second_word)))
                turns.append(ChatTurn("Student", "student", "我会先列步骤，再分配资源。"))
                turns.append(ChatTurn("Trainer", "trainer", "步骤依据是什么？"))
                turns.append(ChatTurn("Student", "student", "依据任务目标和已有材料。"))
                turns.append(ChatTurn("Trainer", "trainer", second_word))
                turns.append(ChatTurn("System", "system", f"检测到跳转词“{second_word}”，即将自动进入下一阶段..."))
            
            if len(cards) > 2:
                third_word = stage_word(cards[2])
                turns.append(ChatTurn("Trainer", "trainer", normalize_dialogue_output(cards[2]["opening"], third_word)))
                turns.append(ChatTurn("Student", "student", "成果是方案清楚，风险是资料不足。"))
                turns.append(ChatTurn("Trainer", "trainer", "很好，本次实训仿真结束。"))
            return turns

        turns: list[ChatTurn] = []
        current_stage_idx = 0
        stage_turns_count = 0

        first_stage = cards[0]
        first_stage_word = stage_word(first_stage)
        # Passive mode should let student initiate the dialogue first.
        if dialogue_mode == "passive":
            turns.append(ChatTurn("Student", "student", "你好，我想先了解当前情况。"))
            turns.append(ChatTurn("Trainer", "trainer", "你好，请问你想先了解哪一部分。"))
        else:
            turns.append(ChatTurn("Trainer", "trainer", normalize_dialogue_output(first_stage["opening"], first_stage_word)))

        # We simulate a total of 30 speech turns maximum (exchanges * 2) as requested by the user
        max_exchanges = 15
        
        for exchange_idx in range(max_exchanges):
            if current_stage_idx >= len(cards):
                break
                
            current_stage = cards[current_stage_idx]
            current_stage_word = stage_word(current_stage)
            current_card_prompt = compile_card_prompt(current_stage, transition_word, metadata=metadata)
            
            # Student response
            student_history = []
            for t in turns:
                if t.role == "system":
                    continue
                role = "assistant" if t.role == "student" else "user"
                student_history.append({"role": role, "content": t.content})
            
            student_mode_rule = (
                "The AI is a passive roleplayer, so you should actively ask concise questions to uncover information."
                if dialogue_mode == "passive"
                else "The AI is a tutor, so respond like a raw student and let the tutor guide you step by step."
            )
            student_system = (
                f"You are simulating a real student in a training session. Your persona is: {student_prompt}.\n"
                f"The trainer/roleplayer persona is: {ai_role}.\n"
                f"Currently in Card {current_stage_idx + 1}: {current_stage['name']}.\n"
                f"CRITICAL ROLEPLAY RULE:\n"
                f"1. {student_mode_rule}\n"
                f"2. Answer the trainer's questions gradually. If the trainer asks multiple things, only answer part of them, or give a slightly simple response first, forcing the trainer to ask follow-up questions to guide you.\n"
                f"3. Speak naturally in Chinese. Keep each response very short (strictly under 40 Chinese characters). Do not include any meta-text.\n"
                f"4. 只能输出直接对话的台词内容，绝对不能包含任何动作、神态、动作描写（如 *点头*、*微笑*、(笑)、(叹气) 等）。"
            )
            student_msg = self.llm.chat([
                {"role": "system", "content": student_system},
                *student_history
            ])
            student_msg = normalize_dialogue_output(student_msg, transition_word=None, limit=40)
            turns.append(ChatTurn("Student", "student", student_msg))
            stage_turns_count += 1

            # Trainer response
            trainer_history = []
            for t in turns:
                if t.role == "system":
                    continue
                role = "assistant" if t.role == "trainer" else "user"
                trainer_history.append({"role": role, "content": t.content})
            
            # Calculate max limit per stage dynamically based on cards suggested limit (max_rounds)
            max_limit_for_this_stage = current_stage.get("max_rounds", 5)
            
            # If the stage has run too long, add a system hint to guide transition
            if stage_turns_count >= max_limit_for_this_stage - 1:
                trainer_history.append({
                    "role": "user",
                    "content": f"[系统提示：当前卡片（{current_stage['name']}）的对话轮次已到上限，如果你认为学生的设计已符合要求，请**仅输出**跳转词“{current_stage_word}”进入下一阶段。]"
                })

            trainer_msg = self.llm.chat([
                {"role": "system", "content": current_card_prompt},
                *trainer_history
            ])
            trainer_msg = normalize_dialogue_output(trainer_msg, transition_word=current_stage_word)
            
            cleaned_trainer_msg = trainer_msg.strip()
            
            if cleaned_trainer_msg == current_stage_word:
                turns.append(ChatTurn("Trainer", "trainer", current_stage_word))
                
                # Check if this was the last stage
                if current_stage_idx == len(cards) - 1:
                    turns.append(ChatTurn("System", "system", f"检测到跳转词“{current_stage_word}”，本次所有阶段训练已全部圆满结束！"))
                    break
                    
                next_stage = cards[current_stage_idx + 1]
                turns.append(ChatTurn("System", "system", f"检测到跳转词“{current_stage_word}”，即将自动进入下一卡片：{next_stage['name']}..."))
                current_stage_idx += 1
                stage_turns_count = 0
                
                # Directly push the next card's opening!
                next_stage_word = stage_word(next_stage)
                turns.append(ChatTurn("Trainer", "trainer", normalize_dialogue_output(next_stage["opening"], next_stage_word)))
            else:
                turns.append(ChatTurn("Trainer", "trainer", trainer_msg))
                
                # Check for forced transition if it exceeds maximum limit
                if stage_turns_count >= max_limit_for_this_stage:
                    # If this was the last stage, end simulation
                    if current_stage_idx == len(cards) - 1:
                        turns.append(ChatTurn("System", "system", "已达到最后一阶段的最大限制轮次，仿真结束。"))
                        break
                        
                    next_stage = cards[current_stage_idx + 1]
                    turns.append(ChatTurn("System", "system", f"已达到本阶段最大限制轮次（{max_limit_for_this_stage}轮），系统强制跳转至下一卡片：{next_stage['name']}..."))
                    current_stage_idx += 1
                    stage_turns_count = 0
                    
                    # Directly push the next card's opening!
                    next_stage_word = stage_word(next_stage)
                    turns.append(ChatTurn("Trainer", "trainer", normalize_dialogue_output(next_stage["opening"], next_stage_word)))

        return turns


class Evaluator:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def evaluate(self, transcript: list[ChatTurn], trainer_prompt: str) -> Evaluation:
        if self.llm.provider == "mock":
            dimensions = {
                "objective_alignment": 90,
                "student_simulation_quality": 85,
                "adaptive_redirect": 88,
                "assessment_rigor": 85,
                "prompt_operability": 86
            }
            score = round(sum(dimensions.values()) / len(dimensions))
            return Evaluation(
                score=score,
                dimensions=dimensions,
                diagnosis=["内置仿真诊断：系统提示词操作流程合理。"],
                recommendations=["可以进一步精细化偏离主题时的对话拉回引导。"]
            )

        transcript_text = "\n".join(f"{t.speaker} ({t.role}): {t.content}" for t in transcript)
        system_msg = textwrap.dedent(
            """
            You are an AI prompt evaluator. Analyze the given training transcript and the Trainer Prompt.
            You must output a JSON object containing:
            {
              "score": <overall_score_0_to_100>,
              "dimensions": {
                "objective_alignment": <score_0_to_100>,
                "student_simulation_quality": <score_0_to_100>,
                "adaptive_redirect": <score_0_to_100>,
                "assessment_rigor": <score_0_to_100>,
                "prompt_operability": <score_0_to_100>
              },
              "diagnosis": ["diagnosis text 1 in Chinese", "diagnosis text 2 in Chinese"],
              "recommendations": ["rec text 1 in Chinese", "rec text 2 in Chinese"]
            }
            The values in diagnosis and recommendations lists MUST be written in Chinese.
            Keep the diagnosis and recommendations lists very short (strictly at most 2 simple items each, under 20 Chinese characters each).
            Respond ONLY with the raw JSON object. Do not include markdown wraps like ```json.
            """
        ).strip()

        user_content = f"Trainer Prompt:\n{trainer_prompt}\n\nTranscript:\n{transcript_text}"
        res = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_content}
        ])

        try:
            cleaned = res.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1]
            if cleaned.endswith("```"):
                cleaned = cleaned.rsplit("\n", 1)[0]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
            
            data = json.loads(cleaned.strip())
            return Evaluation(
                score=int(data["score"]),
                dimensions={k: int(v) for k, v in data["dimensions"].items()},
                diagnosis=data["diagnosis"],
                recommendations=data["recommendations"]
            )
        except Exception as exc:
            return Evaluation(
                score=75,
                dimensions={
                    "objective_alignment": 75,
                    "student_simulation_quality": 75,
                    "adaptive_redirect": 75,
                    "assessment_rigor": 75,
                    "prompt_operability": 75
                },
                diagnosis=[f"大模型评估 JSON 解析失败: {exc}"],
                recommendations=["请检查并重试以获取模型输出。"]
            )


class Optimizer:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def refine(self, trainer_prompt: str, evaluation: Evaluation) -> str:
        if self.llm.provider == "mock":
            notes = "\n".join(f"- {item}" for item in evaluation.recommendations)
            return f"{trainer_prompt}\n\n优化升级细节：\n{notes}"

        system_msg = (
            "You are an expert prompt optimizer. Refine the given Trainer System Prompt in Chinese to address the recommendations provided. "
            "The refined prompt should be complete and explicit. Ensure it retains the instruction to keep normal responses under 100 Chinese characters, only output dialogue, forbid physical/emotional descriptions (e.g. *点头*, (微笑)), never output <think>, and output the exact transition word with no punctuation when transitioning. "
            "Output ONLY the refined prompt in Chinese. Do not include any intro, outro, or explanation."
        )
        user_content = f"Current Prompt:\n{trainer_prompt}\n\nRecommendations:\n" + "\n".join(evaluation.recommendations)
        result = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_content}
        ], temperature=0.45)
        return normalize_dialogue_output(result.strip(), transition_word=None, limit=20000)


class HermesAgent:
    def __init__(self) -> None:
        self.llm = OpenAICompatibleClient()
        self.generator = PromptGenerator(self.llm)
        self.sandbox = AgentSandbox(self.llm)
        self.evaluator = Evaluator(self.llm)
        self.optimizer = Optimizer(self.llm)

    def run(
        self,
        task_document: str,
        threshold: int = 85,
        student_persona: str | None = "auto",
        transition_word: str = "下个阶段",
    ) -> HarnessResult:
        threshold = max(1, min(100, threshold))

        # 1. Dynamically analyze stages/cards from task document
        analyzer = TaskAnalyzer(self.llm)
        task_plan = analyzer.analyze_task(task_document, transition_word=transition_word)
        
        school = task_plan.get("school", "测试学校")
        course = task_plan.get("course", "体育与健康")
        task_type = task_plan.get("task_type", "实训")
        cards = task_plan.get("cards", [])
        evaluation_criteria = task_plan.get("evaluation_criteria", [])
        analyzed_student_persona = task_plan.get("student_persona", "自动测试学生人设")
        extracted_transition_word = task_plan.get("transition_word", transition_word) or transition_word
        metadata = {
            "ai_role": task_plan.get("ai_role", "通用实训导师"),
            "dialogue_mode": task_plan.get("dialogue_mode", "tutor"),
            "transition_rule_desc": task_plan.get("transition_rule_desc", "当学生完成当前阶段核心目标时"),
        }

        print(f"[DEBUG] Analyzed metadata: {school} - {course} ({task_type})")
        print(f"[DEBUG] Analyzed cards count: {len(cards)}")
        print(f"[DEBUG] Extracted transition word: {extracted_transition_word}")
        print(f"[DEBUG] Role/mode: {metadata['ai_role']} / {metadata['dialogue_mode']}")

        # Build trainer prompt based on cards planning
        trainer_prompt = self.generator.create_trainer_prompt(
            task_document, cards=cards, transition_word=extracted_transition_word, metadata=metadata
        )
        
        # Determine student persona (use analyzed student persona if auto selected)
        if not student_persona or student_persona == "auto":
            student_prompt = analyzed_student_persona
        else:
            student_prompt = self.sandbox.create_student_prompt(student_persona)

        result = HarnessResult(
            task_summary=summarize_document(task_document),
            provider=self.llm.provider,
            started_at=datetime.now().isoformat(timespec="seconds"),
            threshold=threshold,
            school=school,
            course=course,
            task_type=task_type,
            cards=cards,
            evaluation_criteria=evaluation_criteria,
            student_persona=student_prompt,
            transition_word=extracted_transition_word,
            ai_role=metadata["ai_role"],
            dialogue_mode=metadata["dialogue_mode"],
            transition_rule_desc=metadata["transition_rule_desc"],
        )

        for index in range(1, 3):
            transcript = self.sandbox.simulate(
                trainer_prompt,
                student_prompt,
                index,
                cards=cards,
                transition_word=extracted_transition_word,
                metadata=metadata,
            )
            evaluation = self.evaluator.evaluate(transcript, trainer_prompt)
            result.rounds.append(HarnessRound(index, trainer_prompt, student_prompt, transcript, evaluation, index > 1))
            if evaluation.score >= threshold:
                break
            trainer_prompt = self.optimizer.refine(trainer_prompt, evaluation)

        result.final_prompt = result.rounds[-1].trainer_prompt
        return result


def summarize_document(task_document: str, limit: int = 500) -> str:
    cleaned = " ".join((task_document or "").split())
    if not cleaned:
        return "创建一个通过模拟学生对话来教学提示词评估的导师提示词。"
    return cleaned[:limit] + ("..." if len(cleaned) > limit else "")


def truncate_task_document(task_document: str, limit: int = MAX_TASK_DOCUMENT_CHARS) -> str:
    return (task_document or "")[:limit]


def result_to_dict(result: HarnessResult) -> dict[str, Any]:
    return {
        "task_summary": result.task_summary,
        "provider": result.provider,
        "started_at": result.started_at,
        "threshold": result.threshold,
        "status": result.status,
        "final_prompt": result.final_prompt,
        "school": result.school,
        "course": result.course,
        "task_type": result.task_type,
        "cards": result.cards,
        "evaluation_criteria": result.evaluation_criteria,
        "student_persona": result.student_persona,
        "transition_word": result.transition_word,
        "ai_role": result.ai_role,
        "dialogue_mode": result.dialogue_mode,
        "transition_rule_desc": result.transition_rule_desc,
        "rounds": [
            {
                "round_number": item.round_number,
                "trainer_prompt": item.trainer_prompt,
                "student_prompt": item.student_prompt,
                "refined": item.refined,
                "transcript": [turn.__dict__ for turn in item.transcript],
                "evaluation": {
                    "score": item.evaluation.score,
                    "dimensions": item.evaluation.dimensions,
                    "diagnosis": item.evaluation.diagnosis,
                    "recommendations": item.evaluation.recommendations,
                },
            }
            for item in result.rounds
        ],
    }
