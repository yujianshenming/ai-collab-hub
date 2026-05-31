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

    def create_trainer_prompt(self, task_document: str) -> str:
        # Add safety truncation limit to prevent gateway RemoteDisconnected errors
        truncated_doc = (task_document or "")[:4000]

        if self.llm.provider == "mock":
            summary = summarize_document(truncated_doc)
            return textwrap.dedent(
                f"""
                你是一个严格的 AI 导师（Hermes Trainer），用于评估和仿真训练。
                训练目标：{summary}
                导师规范：
                - 首先探明学生的认知水平。
                - 采取小步骤、渐进式的教学方法。
                - 一次只提一个具体问题。
                - 遇到学生偏离主题时，温和地引导其重回主线。
                - 在对话结束前进行一次实际应用考核。
                """
            ).strip()

        system_msg = (
            "You are an expert prompt engineer. Your task is to write a concise System Prompt in Chinese (strictly under 300 characters) "
            "for an AI Trainer (called Hermes Trainer) who will train students on the task described in the input document. "
            "The prompt must instruct the Trainer how to test the student, guide them, redirect off-topic dialogue in Chinese, and keep responses concise (under 100 characters). "
            "Respond ONLY with the prompt in Chinese. Do not include markdown block markers, intro, or outro."
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

    def simulate(self, trainer_prompt: str, student_prompt: str, round_number: int) -> list[ChatTurn]:
        if self.llm.provider == "mock":
            distracted = "注意力分散" in student_prompt
            turns = [
                ChatTurn("Trainer", "trainer", "你好！请问你对我们要进行的训练任务有什么了解？"),
                ChatTurn("Student", "student", "我知道提示词很重要，但我通常只是复制例子然后随便改改字。" if distracted else "我理解这个目标，但我需要一个可重复的实践方法。"),
                ChatTurn("Trainer", "trainer", "我们可以使用五步框架：角色、目标、背景、约束和成功标准。"),
                ChatTurn("Student", "student", "我们能不能先讨论怎么让提示词听起来更酷？" if distracted and round_number == 1 else "所以提示词应该明确说明成功标准，而不仅仅是生成什么。"),
                ChatTurn("Trainer", "trainer", "词藻修饰可以稍后进行。让我们先回归目标：请为这个任务写一个成功标准。"),
                ChatTurn("Student", "student", "回答应该包含一个检查清单和一个示例输出。"),
            ]
            return turns

        turns: list[ChatTurn] = []
        # Turn 1: Trainer greeting
        trainer_msg = self.llm.chat([
            {"role": "system", "content": trainer_prompt},
            {"role": "user", "content": "Greet the student, state the training objective, and ask what they know about this task. Speak in Chinese. Keep response under 100 characters."}
        ])
        turns.append(ChatTurn("Trainer", "trainer", trainer_msg))

        # We run 3 rounds of conversation exchange (6 total turns)
        for _ in range(3):
            # Student response
            student_history = []
            for t in turns:
                role = "assistant" if t.role == "student" else "user"
                student_history.append({"role": role, "content": t.content})
            
            student_system = f"You are simulating a student in a training session. Your persona is: {student_prompt}. Follow your persona. Speak directly to the trainer in character. Keep responses very short (strictly under 60 characters). Speak in Chinese."
            student_msg = self.llm.chat([
                {"role": "system", "content": student_system},
                *student_history
            ])
            turns.append(ChatTurn("Student", "student", student_msg))

            # Trainer response
            trainer_history = []
            for t in turns:
                role = "assistant" if t.role == "trainer" else "user"
                trainer_history.append({"role": role, "content": t.content})
            
            trainer_msg = self.llm.chat([
                {"role": "system", "content": trainer_prompt},
                *trainer_history
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

    def run(self, task_document: str, threshold: int = 85, student_persona: str | None = "auto") -> HarnessResult:
        threshold = max(1, min(100, threshold))
        trainer_prompt = self.generator.create_trainer_prompt(task_document)
        student_prompt = self.sandbox.create_student_prompt(student_persona)
        result = HarnessResult(
            task_summary=summarize_document(task_document),
            provider=self.llm.provider,
            started_at=datetime.now().isoformat(timespec="seconds"),
            threshold=threshold,
        )

        for index in range(1, 3):
            transcript = self.sandbox.simulate(trainer_prompt, student_prompt, index)
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
