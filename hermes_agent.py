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
            return f"[Provider fallback] API call failed. Reason: {exc}"

    def _mock_response(self, messages: list[dict[str, str]]) -> str:
        last = messages[-1]["content"] if messages else ""
        return "Mock Hermes response: " + summarize_document(last, 220)


class PromptGenerator:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def create_trainer_prompt(self, task_document: str) -> str:
        if self.llm.provider == "mock":
            summary = summarize_document(task_document)
            return textwrap.dedent(
                f"""
                You are Hermes Agent, a rigorous AI trainer prompt used for simulation and evaluation.
                Training objective: {summary}
                Trainer protocol:
                - Discover the student's baseline first.
                - Teach in short, concrete steps.
                - Ask one question at a time.
                - Redirect off-topic answers without shaming the student.
                """
            ).strip()

        system_msg = "You are an expert prompt engineer. Your task is to write a System Prompt for an AI Trainer (called Hermes Trainer) who will train students on the task described in the input document. The prompt must tell the Trainer how to test the student, guide them, and redirect off-topic dialogue. Respond ONLY with the prompt."
        result = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": f"Task Document:\n{task_document}"}
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
                "Distracted beginner who answers off-topic questions frequently.",
                "Motivated learner who has a general understanding but lacks experience.",
                "Skeptical student who asks for practical proof and examples.",
            ]
        )

    def simulate(self, trainer_prompt: str, student_prompt: str, round_number: int) -> list[ChatTurn]:
        if self.llm.provider == "mock":
            # Fallback to hardcoded mock simulation turns
            distracted = "distracted" in student_prompt.lower()
            turns = [
                ChatTurn("Trainer", "trainer", "What do you already understand about the task we are practicing?"),
                ChatTurn("Student", "student", "I know prompts matter, but I usually just paste examples and tweak random words." if distracted else "I understand the objective, but I need a repeatable method."),
                ChatTurn("Trainer", "trainer", "Use a five-part frame: role, goal, context, constraints, and success criteria."),
                ChatTurn("Student", "student", "Can we focus on making it sound cooler instead?" if distracted and round_number == 1 else "So the prompt should say what success looks like."),
                ChatTurn("Trainer", "trainer", "Style can come later. Let's write one success criterion for this task."),
                ChatTurn("Student", "student", "The answer should include a checklist and one example output."),
            ]
            return turns

        turns: list[ChatTurn] = []
        # Turn 1: Trainer greeting
        trainer_msg = self.llm.chat([
            {"role": "system", "content": trainer_prompt},
            {"role": "user", "content": "Greet the student, state the training objective, and ask what they know about this task."}
        ])
        turns.append(ChatTurn("Trainer", "trainer", trainer_msg))

        # We run 3 rounds of conversation exchange (6 total turns)
        for _ in range(3):
            # Student response
            student_history = []
            for t in turns:
                role = "assistant" if t.role == "student" else "user"
                student_history.append({"role": role, "content": t.content})
            
            student_system = f"You are simulating a student in a training session. Your persona is: {student_prompt}. Follow your persona. Speak directly to the trainer in character. Keep responses very short (1-2 sentences)."
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
            # Simple mock evaluation
            joined = " ".join(turn.content.lower() for turn in transcript)
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
                diagnosis=["Mock assessment: System prompt operates reasonably."],
                recommendations=["Focus on making redirects more explicit."]
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
              "diagnosis": ["issue 1", "issue 2"],
              "recommendations": ["suggestion 1", "suggestion 2"]
            }
            Respond ONLY with the raw JSON object. Do not include markdown wraps like ```json.
            """
        ).strip()

        user_content = f"Trainer Prompt:\n{trainer_prompt}\n\nTranscript:\n{transcript_text}"
        res = self.llm.chat([
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_content}
        ])

        try:
            # Clean possible markdown wrap if the model ignored system prompts
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
            # Fallback on parse failure
            return Evaluation(
                score=75,
                dimensions={
                    "objective_alignment": 75,
                    "student_simulation_quality": 75,
                    "adaptive_redirect": 75,
                    "assessment_rigor": 75,
                    "prompt_operability": 75
                },
                diagnosis=[f"Failed to parse LLM evaluation JSON: {exc}"],
                recommendations=["Ensure model returns properly formatted JSON output."]
            )


class Optimizer:
    def __init__(self, llm: OpenAICompatibleClient) -> None:
        self.llm = llm

    def refine(self, trainer_prompt: str, evaluation: Evaluation) -> str:
        if self.llm.provider == "mock":
            notes = "\n".join(f"- {item}" for item in evaluation.recommendations)
            return f"{trainer_prompt}\n\nRefined guidelines:\n{notes}"

        system_msg = "You are an expert prompt optimizer. Refine the given Trainer System Prompt to address the recommendations provided. Output ONLY the refined prompt. Do not include any meta-text."
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
