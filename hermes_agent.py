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


class PromptGenerator:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def create_trainer_prompt(self, task_document: str, transition_word: str = "下个阶段", suggested_rounds: int = 3) -> str:
        # Add safety truncation limit to prevent gateway RemoteDisconnected errors
        truncated_doc = (task_document or "")[:4000]

        if self.llm.provider == "mock":
            summary = summarize_document(truncated_doc)
            return textwrap.dedent(
                f"""
                你是一个严格的 AI 导师（Hermes Trainer），用于评估和仿真训练。本次训练包含多个阶段。
                训练目标：{summary}
                导师规范：
                - 从阶段一（Stage 1）开始引导，采取小步骤渐进教学。
                - 一次只提一个具体问题，针对当前阶段目标提问（每阶段建议约{suggested_rounds}次对答）。
                - 遇到学生偏离主题时，温和地引导其重回主线。
                - 重要规则：当你确认学生已完全达成当前阶段的目标、可进入下一阶段时，你必须且只能输出“{transition_word}”这四个字，绝对不要附带其他任何标点或文字。
                """
            ).strip()

        system_msg = (
            f"You are an expert prompt engineer. Your task is to write a concise System Prompt in Chinese (strictly under 300 characters) "
            f"for an AI Trainer (called Hermes Trainer) based on the task document. The training program has multiple stages. "
            f"The prompt must instruct the Trainer to:\n"
            f"1. Guide the student sequentially starting from Stage 1 based on the document.\n"
            f"2. Keep responses brief (under 100 characters) and ask questions to test the student (suggested {suggested_rounds} turns per stage).\n"
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
        transition_word: str = "下个阶段",
        suggested_rounds: int = 3,
        max_rounds_per_stage: int = 5,
    ) -> list[ChatTurn]:
        if self.llm.provider == "mock":
            # For mock simulation, we show a multi-stage transition log
            turns = [
                ChatTurn("Trainer", "trainer", "你好！今天我们开始高一体能设计实训。首先请说下阶段一你打算怎么做？"),
                ChatTurn("Student", "student", "第一阶段是恢复体能，我想设计一些跑跳游戏，比如原地高抬腿。"),
                ChatTurn("Trainer", "trainer", "不错，分组和测试方面呢？"),
                ChatTurn("Student", "student", "用健康体能测试，同质和异质分组结合。"),
                ChatTurn("Trainer", "trainer", f"{transition_word}"),
                ChatTurn("System", "system", f"检测到跳转词“{transition_word}”，即将自动进入下一阶段..."),
                ChatTurn("Trainer", "trainer", "很好，已进入第二阶段。这一阶段主要是原理学习，你有什么想法？"),
                ChatTurn("Student", "student", "第二阶段我要设计力量和耐力类练习，采用循环练习法。"),
                ChatTurn("Trainer", "trainer", f"{transition_word}"),
                ChatTurn("System", "system", f"检测到跳转词“{transition_word}”，即将自动进入下一阶段..."),
                ChatTurn("Trainer", "trainer", "很好，进入第三阶段。这一阶段的核心目标是？"),
                ChatTurn("Student", "student", "制订个性化体能锻炼计划，养成坚持锻炼习惯！"),
            ]
            return turns

        turns: list[ChatTurn] = []
        current_stage = 1
        stage_turns_count = 0

        # Turn 1: Trainer greeting
        trainer_msg = self.llm.chat([
            {"role": "system", "content": trainer_prompt},
            {"role": "user", "content": "Greet the student, introduce Stage 1 (recovery and interest assessment), and ask what they know or plan. Speak in Chinese. Keep response under 100 characters."}
        ])
        turns.append(ChatTurn("Trainer", "trainer", trainer_msg))

        # We simulate a total of 12 speech exchanges maximum (which handles multiple stages)
        # We will dynamically transition through stages when transition_word is matched
        for exchange_idx in range(12):
            # Student response
            student_history = []
            for t in turns:
                if t.role == "system":
                    continue
                role = "assistant" if t.role == "student" else "user"
                student_history.append({"role": role, "content": t.content})
            
            student_system = (
                f"You are simulating a student in a training session. Your persona is: {student_prompt}. "
                f"Follow your persona, behave cooperative, and try to complete the requested stage objectives. "
                f"Keep responses very short (strictly under 60 characters). Speak in Chinese."
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
            
            # If the stage has run too long, add a system hint to guide transition
            if stage_turns_count >= max_rounds_per_stage - 1:
                trainer_history.append({
                    "role": "user",
                    "content": f"[系统提示：本阶段的对话轮次已到上限，如果你认为学生的设计已符合当前阶段要求，请**仅输出**跳转词“{transition_word}”进入下一阶段。]"
                })

            trainer_msg = self.llm.chat([
                {"role": "system", "content": trainer_prompt},
                *trainer_history
            ])
            
            # Check for transition trigger (case/punctuation insensitive)
            cleaned_trainer_msg = trainer_msg.strip().replace("。", "").replace("！", "").replace(".", "")
            
            if cleaned_trainer_msg == transition_word:
                turns.append(ChatTurn("Trainer", "trainer", transition_word))
                turns.append(ChatTurn("System", "system", f"检测到跳转词“{transition_word}”，即将自动进入下一阶段..."))
                current_stage += 1
                stage_turns_count = 0
                
                # Immediately call trainer again to start the next stage
                next_history = []
                for t in turns:
                    if t.role == "system":
                        continue
                    role = "assistant" if t.role == "trainer" else "user"
                    next_history.append({"role": role, "content": t.content})
                next_history.append({
                    "role": "user",
                    "content": f"[系统提示：检测到跳转词。你已成功切换至阶段 {current_stage}。请向学生介绍阶段 {current_stage} 的任务要求并提出第一个问题。]"
                })
                trainer_msg = self.llm.chat([
                    {"role": "system", "content": trainer_prompt},
                    *next_history
                ])
                turns.append(ChatTurn("Trainer", "trainer", trainer_msg))
            else:
                turns.append(ChatTurn("Trainer", "trainer", trainer_msg))
                
                # Check for forced transition if it exceeds maximum limit
                if stage_turns_count >= max_rounds_per_stage:
                    turns.append(ChatTurn("System", "system", f"已达到最大限制轮次（{max_rounds_per_stage}轮），系统强制跳转至下一阶段..."))
                    current_stage += 1
                    stage_turns_count = 0
                    
                    next_history = []
                    for t in turns:
                        if t.role == "system":
                            continue
                        role = "assistant" if t.role == "trainer" else "user"
                        next_history.append({"role": role, "content": t.content})
                    next_history.append({
                        "role": "user",
                        "content": f"[系统提示：已强制切换至阶段 {current_stage}。请向学生介绍阶段 {current_stage} 的任务要求并提出第一个问题。]"
                    })
                    trainer_msg = self.llm.chat([
                        {"role": "system", "content": trainer_prompt},
                        *next_history
                    ])
                    turns.append(ChatTurn("Trainer", "trainer", trainer_msg))

        return turns


class Evaluator:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def evaluate(self, transcript: list[ChatTurn], trainer_prompt: str) -> Evaluation:
        if self.llm.provider == "mock":
            dimensions = {
                "objective_alignment": 90 if "objective" in trainer_prompt.lower() else 75,
                "student_simulation_quality": 85,
                "adaptive_redirect": 88 if "redirect" in trainer_prompt.lower() else 70,
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
        suggested_rounds: int = 3,
        max_rounds_per_stage: int = 5,
    ) -> HarnessResult:
        threshold = max(1, min(100, threshold))
        trainer_prompt = self.generator.create_trainer_prompt(
            task_document, transition_word=transition_word, suggested_rounds=suggested_rounds
        )
        student_prompt = self.sandbox.create_student_prompt(student_persona)
        result = HarnessResult(
            task_summary=summarize_document(task_document),
            provider=self.llm.provider,
            started_at=datetime.now().isoformat(timespec="seconds"),
            threshold=threshold,
        )

        for index in range(1, 3):
            transcript = self.sandbox.simulate(
                trainer_prompt,
                student_prompt,
                index,
                transition_word=transition_word,
                suggested_rounds=suggested_rounds,
                max_rounds_per_stage=max_rounds_per_stage,
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
