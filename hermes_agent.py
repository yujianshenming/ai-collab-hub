from __future__ import annotations

import json
import os
import random
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
            with urllib.request.urlopen(request, timeout=25) as response:
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
                "school": "测试第一中学",
                "course": "高中体育与健康",
                "task_type": "教学计划设计",
                "cards": [
                    {
                        "stage_number": 1,
                        "name": "阶段一：体能恢复与评估",
                        "max_rounds": 6,
                        "description": "引导学生设计恢复游戏和完成体能测试评估",
                        "opening": "你好！今天我们进行高一体能设计实训。请问阶段一你打算怎么做？",
                        "evaluation_points": "学生必须明确说明评估方式（如健康测试）与具体的跑跳恢复游戏，并提及同质/异质分组。",
                        "prompt": f"引导学生完成阶段一的设计。重点考察评估方式、分组手段及恢复游戏设计。当学生回答出这两点后，仅输出“{transition_word}”。"
                    },
                    {
                        "stage_number": 2,
                        "name": "阶段二：科学锻炼原理学习",
                        "max_rounds": 6,
                        "description": "引导学生结合学习目标设计教学重难点与学练内容",
                        "opening": "很好，已进入第二阶段。这一阶段主要是科学锻炼原理，你有什么想法？",
                        "evaluation_points": "学生必须清晰划分出本阶段教学的重难点，并列举灵敏（如闪躲跑）、速度及力量（蛙跳）设计学练内容。",
                        "prompt": f"引导学生理清阶段二的教学重难点，设计速度、灵敏和力量（蛙跳）学练内容。合格后仅输出“{transition_word}”。"
                    },
                    {
                        "stage_number": 3,
                        "name": "阶段三：计划制订与习惯养成",
                        "max_rounds": 6,
                        "description": "引导学生结合自身情况制订锻炼计划并长期坚持",
                        "opening": "很好，进入最终阶段。这一阶段的核心目标是计划制订与习惯养成，请问你的设计是？",
                        "evaluation_points": "学生必须设计个性化体能计划，并提供引导与监督学生养成坚持锻炼习惯的具体手段。",
                        "prompt": "引导学生设计个性化计划和习惯监督机制。完成后给出一段实训考核总结并结束对话。"
                    }
                ],
                "evaluation_criteria": [
                    "体能模块教学计划设计必须贴合目标",
                    "各阶段教学设计需符合高一学生身心发展规律",
                    "教学方法与手段设计需体现科学合理性"
                ],
                "student_persona": "注意力分散的初学者，偏好简单回答，跑题但顺从。"
            }

        system_msg = textwrap.dedent(
            f"""
            You are a pedagogical design and prompt engineering expert. Analyze the provided task document in Chinese and output a complete training plan structure in JSON format.
            The JSON object must contain exactly the following keys:
            {{
              "school": "Automatically extract the school name or default to '高中'",
              "course": "Automatically extract the course name or default to '体育学'",
              "task_type": "Extract the task type (e.g. 实训/作业/课程设计)",
              "cards": [
                {{
                  "stage_number": 1,
                  "name": "Card name in Chinese (e.g., 阶段一：体能恢复与评估)",
                  "max_rounds": <integer suggested rounds, between 4 and 6 depending on complexity>,
                  "description": "Stage description in Chinese (under 40 chars)",
                  "opening": "First greeting question from the Trainer to start this stage in Chinese (under 50 chars)",
                  "evaluation_points": "Specific criteria for the student's answer in this stage (e.g., must list 3 games and grouping rules) in Chinese (under 60 chars)",
                  "prompt": "Trainer guide system prompt for this stage in Chinese (under 120 chars) instructing how to guide and when to transition (output '{transition_word}')."
                }},
                ...
              ],
              "evaluation_criteria": [
                "Evaluation criterion 1 in Chinese (under 30 chars)",
                "Evaluation criterion 2 in Chinese"
              ],
              "student_persona": "Custom student persona description for simulation based on common learning difficulties (under 40 chars) in Chinese"
            }}
            Ensure that for each card, the Trainer prompt instructs the trainer to ONLY output the transition word '{transition_word}' (and absolutely nothing else) when the student achieves that card's goals.
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
            required_keys = {"school", "course", "task_type", "cards", "evaluation_criteria", "student_persona"}
            if not required_keys.issubset(data):
                raise ValueError("Missing required JSON keys")
            return data
        except Exception as exc:
            print(f"[API Warning] Dynamic task analysis failed: {exc}. Using default fallback.")
            self.force_mock = True
            return self.analyze_task(None, transition_word=transition_word)


def compile_card_prompt(card_data: dict[str, Any], transition_word: str) -> str:
    name = card_data.get("name", "未命名阶段")
    description = card_data.get("description", "设计本阶段任务")
    max_rounds = card_data.get("max_rounds", 4)
    eval_points = card_data.get("evaluation_points", "设计合理的教学内容与方法")
    micro_prompt = card_data.get("prompt", "引导学生完成本阶段设计")

    template = f"""# 角色设定
你是一名专业的高中体育教师（AI 培训导师）。你的任务是根据《学校体育学》的核心教学规律，引导学生（教学设计者）完成高一第一学期体能模块设计实训。

# 当前卡片设定
- 卡片名称：{name}
- 核心任务：{description}
- 上限轮次：{max_rounds} 轮

# 导师专属引导提示（Micro Prompt）
{micro_prompt}

# 核心教学规范
1. 一次只能提一个问题。采取循序渐进的启发式提问，绝对不能一次性抛出多个要求。
2. 围绕以下核心评估要点引导学生进行深度设计：
   {eval_points}
3. 严禁直接替学生给出方案。如果学生回答含糊、缺失关键点，必须进行追问，直到学生回答出具体游戏、学练内容（如跑跳、灵敏练习、蛙跳等）和教学方法。
4. 如果学生偏离本阶段主题，温和引导其重回主线。

# 阶段跳转切档规则（极其重要）
当你确信学生已经完全设计好本卡片的所有核心细节，且在【核心评估要点】上达到了合格标准时，你必须**仅输出“{transition_word}”**这四个字，绝对不要附加任何其他话语、解释、多余字符或标点符号。这是切档的唯一指令。
"""
    return template.strip()


class PromptGenerator:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def create_trainer_prompt(self, task_document: str, cards: list[dict[str, Any]], transition_word: str = "下个阶段") -> str:
        truncated_doc = (task_document or "")[:4000]
        stages_text = "\n".join(f"- 阶段 {c['stage_number']}（{c['name']}）：{c['description']}（上限轮次: {c['max_rounds']}）" for c in cards)

        if self.llm.provider == "mock":
            return textwrap.dedent(
                f"""
                你是一个严格的 AI 导师（Hermes Trainer），用于评估和仿真训练。本次训练包含以下阶段：
                {stages_text}
                导师规范：
                - 从阶段一开始引导，采取小步骤渐进教学。
                - 一次只提一个具体问题，针对当前阶段目标提问。
                - 重要规则：当你确认学生已完全达成当前阶段的目标、可进入下一阶段时，你必须且只能输出“{transition_word}”这四个字，绝对不要附带其他任何标点或文字。
                """
            ).strip()

        system_msg = (
            f"You are an expert prompt engineer. Your task is to write a concise System Prompt in Chinese (strictly under 300 characters) "
            f"for an AI Trainer (called Hermes Trainer) based on the task document. The training program has the following stages:\n"
            f"{stages_text}\n"
            f"The prompt must instruct the Trainer to:\n"
            f"1. Guide the student sequentially starting from Stage 1 based on the document.\n"
            f"2. Keep responses brief (under 100 characters) and ask questions to test the student on each stage's objective.\n"
            f"3. CRITICAL RULE: When the Trainer decides the student has achieved the current stage's objective and is ready to enter the next stage, "
            f"the Trainer MUST output ONLY the transition word '{transition_word}' and absolutely nothing else (no punctuation, no other words).\n"
            f"Respond ONLY with the prompt in Chinese. Do not include markdown block markers, intro, or outro."
        )
        result = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": f"Task Document:\n{truncated_doc}"}
        ])
        return result.strip()


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
    ) -> list[ChatTurn]:
        if self.llm.provider == "mock":
            # Detailed mock transcript to show realistic multi-stage dialogue flow
            turns = []
            turns.append(ChatTurn("Trainer", "trainer", cards[0]["opening"]))
            turns.append(ChatTurn("Student", "student", "我想设计一些小游戏来恢复体能。"))
            turns.append(ChatTurn("Trainer", "trainer", "具体设计什么游戏呢？请举例说明游戏名称及规则。"))
            turns.append(ChatTurn("Student", "student", "比如跑跳结合游戏、跳台阶游戏和原地高抬腿比赛。"))
            turns.append(ChatTurn("Trainer", "trainer", "很好。那体能评估和分组上有什么安排？"))
            turns.append(ChatTurn("Student", "student", "用健康体能测试，同质和异质分组结合。"))
            turns.append(ChatTurn("Trainer", "trainer", transition_word))
            turns.append(ChatTurn("System", "system", f"检测到跳转词“{transition_word}”，即将自动进入下一阶段..."))
            
            if len(cards) > 1:
                turns.append(ChatTurn("Trainer", "trainer", cards[1]["opening"]))
                turns.append(ChatTurn("Student", "student", "重难点是掌握科学锻炼原理，难点是磨炼意志。"))
                turns.append(ChatTurn("Trainer", "trainer", "那么这一阶段具体的学练内容包含哪些分类？"))
                turns.append(ChatTurn("Student", "student", "包含速度跑（100米）、灵敏（十字象限跳）和蛙跳。"))
                turns.append(ChatTurn("Trainer", "trainer", transition_word))
                turns.append(ChatTurn("System", "system", f"检测到跳转词“{transition_word}”，即将自动进入下一阶段..."))
            
            if len(cards) > 2:
                turns.append(ChatTurn("Trainer", "trainer", cards[2]["opening"]))
                turns.append(ChatTurn("Student", "student", "引导学生制订个性化计划，并让组长和体育教师共同监督。"))
                turns.append(ChatTurn("Trainer", "trainer", "非常好。这套教学计划设计实训到此圆满完成，期待你的实际交付！"))
            return turns

        turns: list[ChatTurn] = []
        current_stage_idx = 0
        stage_turns_count = 0

        # Turn 1: Trainer greeting (Use the opening of the first card directly!)
        turns.append(ChatTurn("Trainer", "trainer", cards[0]["opening"]))

        # We simulate a total of 30 speech turns maximum (exchanges * 2) as requested by the user
        max_exchanges = 15
        
        for exchange_idx in range(max_exchanges):
            if current_stage_idx >= len(cards):
                break
                
            current_stage = cards[current_stage_idx]
            current_card_prompt = compile_card_prompt(current_stage, transition_word)
            
            # Student response
            student_history = []
            for t in turns:
                if t.role == "system":
                    continue
                role = "assistant" if t.role == "student" else "user"
                student_history.append({"role": role, "content": t.content})
            
            student_system = (
                f"You are simulating a student in a P.E. training session. Your persona is: {student_prompt}.\n"
                f"Currently in Card {current_stage_idx + 1}: {current_stage['name']}.\n"
                f"CRITICAL ROLEPLAY RULE:\n"
                f"1. Behave like a real, slightly raw student. Do NOT give perfect, complete answers immediately.\n"
                f"2. Answer the trainer's questions gradually. If the trainer asks multiple things, only answer part of them, or give a slightly simple response first, forcing the trainer to ask follow-up questions to guide you.\n"
                f"3. Speak naturally in Chinese. Keep each response very short (strictly under 40 Chinese characters). Do not include any meta-text."
            )
            student_msg = self.llm.chat([
                {"role": "system", "content": student_system},
                *student_history
            ])
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
                    "content": f"[系统提示：当前卡片（{current_stage['name']}）的对话轮次已到上限，如果你认为学生的设计已符合要求，请**仅输出**跳转词“{transition_word}”进入下一阶段。]"
                })

            trainer_msg = self.llm.chat([
                {"role": "system", "content": current_card_prompt},
                *trainer_history
            ])
            
            # Check for transition trigger (case/punctuation insensitive)
            cleaned_trainer_msg = trainer_msg.strip().replace("。", "").replace("！", "").replace(".", "")
            
            if cleaned_trainer_msg == transition_word:
                turns.append(ChatTurn("Trainer", "trainer", transition_word))
                
                # Check if this was the last stage
                if current_stage_idx == len(cards) - 1:
                    turns.append(ChatTurn("System", "system", f"检测到跳转词“{transition_word}”，本次所有阶段训练已全部圆满结束！"))
                    break
                    
                next_stage = cards[current_stage_idx + 1]
                turns.append(ChatTurn("System", "system", f"检测到跳转词“{transition_word}”，即将自动进入下一卡片：{next_stage['name']}..."))
                current_stage_idx += 1
                stage_turns_count = 0
                
                # Directly push the next card's opening!
                turns.append(ChatTurn("Trainer", "trainer", next_stage["opening"]))
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
                    turns.append(ChatTurn("Trainer", "trainer", next_stage["opening"]))

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
            "The refined prompt must be concise (strictly under 300 characters). Output ONLY the refined prompt in Chinese. Do not include any intro, outro, or explanation."
        )
        user_content = f"Current Prompt:\n{trainer_prompt}\n\nRecommendations:\n" + "\n".join(evaluation.recommendations)
        result = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_content}
        ], temperature=0.45)
        return result.strip()


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

        print(f"[DEBUG] Analyzed metadata: {school} - {course} ({task_type})")
        print(f"[DEBUG] Analyzed cards count: {len(cards)}")

        # Build trainer prompt based on cards planning
        trainer_prompt = self.generator.create_trainer_prompt(
            task_document, cards=cards, transition_word=transition_word
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
        )

        for index in range(1, 3):
            transcript = self.sandbox.simulate(
                trainer_prompt,
                student_prompt,
                index,
                cards=cards,
                transition_word=transition_word,
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
