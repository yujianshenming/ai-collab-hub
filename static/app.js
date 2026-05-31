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
  button.textContent = "仿真评估运行中...";
  chatLog.innerHTML = '<div class="empty">正在根据大纲生成提示词、启动智能体对话沙箱并评估多轮对话质量...</div>';

  try {
    const payload = new FormData(form);
    const response = await fetch("/api/start-harness", {
      method: "POST",
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`服务请求失败: ${response.status}`);
    }

    renderResult(await response.json());
  } catch (error) {
    chatLog.innerHTML = `<div class="empty">执行错误: ${error.message}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "启动仿真评估";
  }
});

function renderResult(result) {
  providerPill.textContent = result.provider === "mock" ? "内置模拟引擎" : `大语言模型: ${result.provider}`;
  const latestRound = result.rounds[result.rounds.length - 1];
  score.textContent = latestRound.evaluation.score;
  finalPrompt.textContent = result.final_prompt;

  chatLog.innerHTML = "";
  result.rounds.forEach((round) => {
    const marker = document.createElement("div");
    marker.className = "empty";
    marker.textContent = `第 ${round.round_number} 轮仿真${round.refined ? " (已融合优化建议)" : " (初始提示词测试)"}`;
    chatLog.appendChild(marker);

    round.transcript.forEach((turn) => {
      const bubble = document.createElement("div");
      const isTrainer = turn.role === "trainer";
      bubble.className = `bubble ${turn.role}`;
      bubble.innerHTML = `<span class="speaker">${isTrainer ? "AI 导师 (Trainer)" : "模拟学生 (Student)"}</span>${escapeHtml(turn.content)}`;
      chatLog.appendChild(bubble);
    });
  });

  dimensions.innerHTML = "";
  
  // Define mapping for dimension keys to Chinese display names
  const nameMap = {
    "objective_alignment": "任务目标对齐度",
    "student_simulation_quality": "学生仿真逼真度",
    "adaptive_redirect": "注意力偏差引导力",
    "assessment_rigor": "考核评估严谨度",
    "prompt_operability": "提示词可执行度"
  };

  Object.entries(latestRound.evaluation.dimensions).forEach(([name, value]) => {
    const metric = document.createElement("div");
    metric.className = "metric";
    const displayName = nameMap[name] || name.replaceAll("_", " ");
    metric.innerHTML = `
      <div class="metric-row"><span>${displayName}</span><strong>${value} 分</strong></div>
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
