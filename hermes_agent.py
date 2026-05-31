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
            with urllib.request.urlopen(request, timeout=45) as response:
                data = json.loads(response.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
        except (urllib.error.URLError, KeyError, IndexError, json.JSONDecodeError) as exc:
            return f"[Provider fallback] API call failed, using local simulation. Reason: {exc}"

    def _mock_response(self, messages: list[dict[str, str]]) -> str:
        last = messages[-1]["content"] if messages else ""
        return "Mock Hermes response: " + summarize_document(last, 220)


class PromptGenerator:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def create_trainer_prompt(self, task_document: str) -> str:
        summary = summarize_document(task_document)
        llm_hint = self.llm.chat(
            [
                {"role": "system", "content": "Extract the core training objective in one compact paragraph."},
                {"role": "user", "content": summary},
            ]
        )
        return textwrap.dedent(
            f"""
            You are Hermes Agent, a rigorous AI trainer prompt used for simulation and evaluation.

            Training objective:
            {summary}

            Model analysis hint:
            {llm_hint}

            Trainer protocol:
            - Discover the student's baseline first.
            - Teach in short, concrete steps.
            - Ask one question at a time.
            - Redirect off-topic answers without shaming the student.
            - Require an applied final check.
            - End with a concise rubric-based assessment.
            """
        ).strip()


class AgentSandbox:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def create_student_prompt(self, requested_persona: str | None) -> str:
        if requested_persona and requested_persona != "auto":
            return requested_persona
        return random.choice(
            [
                "Distracted beginner who mixes correct answers with unrelated concerns.",
                "Practical learner who wants examples before theory.",
                "Skeptical operator who challenges vague instructions.",
            ]
        )

    def simulate(self, trainer_prompt: str, student_prompt: str, round_number: int) -> list[ChatTurn]:
        distracted = "distracted" in student_prompt.lower()
        refined = "rubric" in trainer_prompt.lower() and "redirect" in trainer_prompt.lower()
        turns = [
            ChatTurn("Trainer", "trainer", "What do you already understand about the task we are practicing?"),
            ChatTurn(
                "Student",
                "student",
                "I know prompts matter, but I usually just paste examples and tweak random words."
                if distracted
                else "I understand the objective, but I need a repeatable method.",
            ),
            ChatTurn(
                "Trainer",
                "trainer",
                "Use a five-part frame: role, goal, context, constraints, and success criteria.",
            ),
            ChatTurn(
                "Student",
                "student",
                "Can we focus on making it sound cooler instead?"
                if distracted and round_number == 1
                else "So the prompt should say what success looks like, not just what to generate.",
            ),
            ChatTurn(
                "Trainer",
                "trainer",
                "Style can come later. First, bridge back to the objective: write one success criterion for this task.",
            ),
            ChatTurn("Student", "student", "The answer should include a checklist and one example output."),
            ChatTurn("Trainer", "trainer", "Final check: create a one-sentence trainer instruction and score it against the frame."),
            ChatTurn("Student", "student", "Act as a coach, ask one question at a time, and verify my answer with a checklist."),
        ]
        if refined:
            turns.append(ChatTurn("Trainer", "trainer", "Rubric: role present, task specific, success check observable. Score: 3/3."))
        return turns


class Evaluator:
    def evaluate(self, transcript: list[ChatTurn], trainer_prompt: str) -> Evaluation:
        joined = " ".join(turn.content.lower() for turn in transcript)
        dimensions = {
            "objective_alignment": 90 if "training objective" in trainer_prompt.lower() else 72,
            "student_simulation_quality": 88 if "random words" in joined or "repeatable method" in joined else 75,
            "adaptive_redirect": 90 if "bridge back" in joined else 70,
            "assessment_rigor": 92 if "rubric" in joined else 78,
            "prompt_operability": 88 if "one question at a time" in trainer_prompt.lower() else 74,
        }
        score = round(sum(dimensions.values()) / len(dimensions))
        diagnosis: list[str] = []
        recommendations: list[str] = []
        if dimensions["assessment_rigor"] < 85:
            diagnosis.append("Final assessment exists but lacks a visible rubric.")
            recommendations.append("Add a compact rubric with pass/fail criteria.")
        if dimensions["adaptive_redirect"] < 85:
            diagnosis.append("The trainer needs a stronger redirect pattern for off-topic answers.")
            recommendations.append("Use acknowledge-bridge-question when the student drifts.")
        if not diagnosis:
            diagnosis.append("Simulation reached the learning objective with observable student progress.")
            recommendations.append("Preserve the trainer's redirect and rubric patterns.")
        return Evaluation(score, dimensions, diagnosis, recommendations)


class Optimizer:
    def refine(self, trainer_prompt: str, evaluation: Evaluation) -> str:
        notes = "\n".join(f"- {item}" for item in evaluation.recommendations)
        return (
            f"{trainer_prompt}\n\nEvaluator-driven refinements:\n{notes}\n"
            "- Use acknowledge-bridge-question for off-topic student responses.\n"
            "- End with a three-point rubric and explicit pass/fail signal."
        )


class HermesAgent:
    def __init__(self) -> None:
        self.llm = OpenAICompatibleClient()
        self.generator = PromptGenerator(self.llm)
        self.sandbox = AgentSandbox(self.llm)
        self.evaluator = Evaluator()
        self.optimizer = Optimizer()

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
        return "Create a trainer prompt that teaches prompt evaluation through simulated student dialogue."
    return cleaned[:limit] + ("..." if len(cleaned) > limit else "")


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
