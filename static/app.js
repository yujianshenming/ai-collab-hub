const form = document.querySelector("#harness-form");
const threshold = form.elements.threshold;
const thresholdValue = document.querySelector("#threshold-value");
const chatLog = document.querySelector("#chat-log");
const providerPill = document.querySelector("#provider-pill");
const score = document.querySelector("#score");
const dimensions = document.querySelector("#dimensions");
const diagnosis = document.querySelector("#diagnosis");
const finalPrompt = document.querySelector("#final-prompt");

threshold.addEventListener("input", () => {
  thresholdValue.textContent = threshold.value;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Simulating...";
  chatLog.innerHTML = '<div class="empty">Generating prompt, running sandbox, and scoring transcript...</div>';

  try {
    const payload = new FormData(form);
    const response = await fetch("/api/start-harness", {
      method: "POST",
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    renderResult(await response.json());
  } catch (error) {
    chatLog.innerHTML = `<div class="empty">${error.message}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "Run simulation";
  }
});

function renderResult(result) {
  providerPill.textContent = result.provider;
  const latestRound = result.rounds[result.rounds.length - 1];
  score.textContent = latestRound.evaluation.score;
  finalPrompt.textContent = result.final_prompt;

  chatLog.innerHTML = "";
  result.rounds.forEach((round) => {
    const marker = document.createElement("div");
    marker.className = "empty";
    marker.textContent = `Round ${round.round_number}${round.refined ? " - refined prompt" : ""}`;
    chatLog.appendChild(marker);

    round.transcript.forEach((turn) => {
      const bubble = document.createElement("div");
      bubble.className = `bubble ${turn.role}`;
      bubble.innerHTML = `<span class="speaker">${turn.speaker}</span>${escapeHtml(turn.content)}`;
      chatLog.appendChild(bubble);
    });
  });

  dimensions.innerHTML = "";
  Object.entries(latestRound.evaluation.dimensions).forEach(([name, value]) => {
    const metric = document.createElement("div");
    metric.className = "metric";
    metric.innerHTML = `
      <div class="metric-row"><span>${name.replaceAll("_", " ")}</span><strong>${value}</strong></div>
      <div class="bar"><span style="width:${value}%"></span></div>
    `;
    dimensions.appendChild(metric);
  });

  diagnosis.innerHTML = "";
  [...latestRound.evaluation.diagnosis, ...latestRound.evaluation.recommendations].forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    diagnosis.appendChild(li);
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[char];
  });
}
