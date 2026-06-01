const form = document.querySelector("#harness-form");
const threshold = form.elements.threshold;
const thresholdValue = document.querySelector("#threshold-value");
const chatLog = document.querySelector("#chat-log");
const providerPill = document.querySelector("#provider-pill");
const score = document.querySelector("#score");
const dimensions = document.querySelector("#dimensions");
const diagnosis = document.querySelector("#diagnosis");
const initialPrompt = document.querySelector("#initial-prompt");
const finalPrompt = document.querySelector("#final-prompt");
const studentPersonaDisplay = document.querySelector("#student-persona-display");

// Metadata elements
const metaSchool = document.querySelector("#meta-school");
const metaCourse = document.querySelector("#meta-course");
const metaType = document.querySelector("#meta-type");
const metaStatus = document.querySelector("#meta-status");
const cardsContainer = document.querySelector("#cards-container");
const evaluationCriteriaList = document.querySelector("#evaluation-criteria-list");

threshold.addEventListener("input", () => {
  thresholdValue.textContent = threshold.value;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "仿真评估运行中...";
  chatLog.innerHTML = '<div class="empty">正在根据大纲生成提示词、启动智能体对话沙箱并评估多轮对话质量...</div>';
  initialPrompt.textContent = "正在生成提示词...";
  finalPrompt.textContent = "正在优化提示词...";
  studentPersonaDisplay.textContent = "正在确定学生人设...";
  
  metaSchool.textContent = "分析中...";
  metaCourse.textContent = "分析中...";
  metaType.textContent = "分析中...";
  metaStatus.textContent = "进行中";
  metaStatus.className = "status-pill";
  cardsContainer.innerHTML = '<div class="empty">正在根据任务文档生成多阶段卡片方案...</div>';
  evaluationCriteriaList.innerHTML = '<li>正在生成评价标准...</li>';

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
    initialPrompt.textContent = "执行失败";
    finalPrompt.textContent = "执行失败";
    studentPersonaDisplay.textContent = "执行失败";
    metaStatus.textContent = "执行失败";
  } finally {
    button.disabled = false;
    button.textContent = "开始生成提示词并仿真评估";
  }
});

function renderResult(result) {
  providerPill.textContent = result.provider === "mock" ? "内置模拟引擎" : `大语言模型: ${result.provider}`;
  const latestRound = result.rounds[result.rounds.length - 1];
  score.textContent = latestRound.evaluation.score;
  
  // Render initial generated prompt from round 1, and final prompt
  initialPrompt.textContent = result.rounds[0].trainer_prompt;
  finalPrompt.textContent = result.final_prompt;
  studentPersonaDisplay.textContent = result.student_persona;

  // Render Metadata
  metaSchool.textContent = result.school || "--";
  metaCourse.textContent = result.course || "--";
  metaType.textContent = result.task_type || "--";
  metaStatus.textContent = "已完成";
  metaStatus.className = "status-pill";
  if (result.transition_word) {
    form.elements.transition_word.value = result.transition_word;
  }

  // Render Evaluation Criteria
  evaluationCriteriaList.innerHTML = "";
  if (result.evaluation_criteria && result.evaluation_criteria.length > 0) {
    result.evaluation_criteria.forEach(criterion => {
      const li = document.createElement("li");
      li.textContent = criterion;
      evaluationCriteriaList.appendChild(li);
    });
  } else {
    evaluationCriteriaList.innerHTML = "<li>无提取的标准</li>";
  }

  // Render Cards (Stages)
  cardsContainer.innerHTML = "";
  if (result.cards && result.cards.length > 0) {
    result.cards.forEach((card) => {
      const cardDiv = document.createElement("div");
      cardDiv.className = "card-item";
      cardDiv.innerHTML = `
        <div class="card-item-header">
          <span class="card-title">${escapeHtml(card.name)}</span>
          <span class="card-rounds">上限轮次: ${card.max_rounds} 轮</span>
        </div>
        <div class="card-body">
          <div class="card-field">
            <div class="card-field-header">
              <span class="card-field-label">阶段描述</span>
              <button type="button" class="copy-btn" onclick="copyDirectText(this)">复制</button>
            </div>
            <div class="card-field-value text-to-copy">${escapeHtml(card.description)}</div>
          </div>
          <div class="card-field">
            <div class="card-field-header">
              <span class="card-field-label">评估要点</span>
              <button type="button" class="copy-btn" onclick="copyDirectText(this)">复制</button>
            </div>
            <div class="card-field-value text-to-copy">${escapeHtml(card.evaluation_points)}</div>
          </div>
          <div class="card-field">
            <div class="card-field-header">
              <span class="card-field-label">开场白</span>
              <button type="button" class="copy-btn" onclick="copyDirectText(this)">复制</button>
            </div>
            <div class="card-field-value text-to-copy">${escapeHtml(card.opening)}</div>
          </div>
          <div class="card-field">
            <div class="card-field-header">
              <span class="card-field-label">提示词 (System Prompt)</span>
              <button type="button" class="copy-btn" onclick="copyDirectText(this)">复制</button>
            </div>
            <pre class="card-field-value text-to-copy">${escapeHtml(card.prompt)}</pre>
          </div>
        </div>
      `;
      cardsContainer.appendChild(cardDiv);
    });
  } else {
    cardsContainer.innerHTML = '<div class="empty">无提取的卡片方案</div>';
  }

  chatLog.innerHTML = "";
  result.rounds.forEach((round) => {
    const marker = document.createElement("div");
    marker.className = "empty";
    marker.textContent = `第 ${round.round_number} 轮仿真${round.refined ? " (已融合优化建议)" : " (初始提示词测试)"}`;
    chatLog.appendChild(marker);

    round.transcript.forEach((turn) => {
      const bubble = document.createElement("div");
      bubble.className = `bubble ${turn.role}`;
      if (turn.role === "system") {
        bubble.innerHTML = `<span class="speaker">[系统消息]</span>${escapeHtml(turn.content)}`;
      } else {
        const isTrainer = turn.role === "trainer";
        bubble.innerHTML = `<span class="speaker">${isTrainer ? "AI 导师 (Trainer)" : "模拟学生 (Student)"}</span>${escapeHtml(turn.content)}`;
      }
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
  if (!value) return "";
  return value.toString().replace(/[&<>"']/g, (char) => {
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

function copyText(elementId, button) {
  const text = document.getElementById(elementId).textContent;
  if (!text || text.includes("等待") || text.includes("失败")) {
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    const originalText = button.textContent;
    button.textContent = "已复制!";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove("copied");
    }, 2000);
  }).catch(err => {
    console.error("Failed to copy text: ", err);
  });
}

function copyDirectText(button) {
  const fieldContainer = button.closest(".card-field");
  const textElement = fieldContainer.querySelector(".text-to-copy");
  const text = textElement.textContent;
  if (!text || text.includes("等待")) {
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    const originalText = button.textContent;
    button.textContent = "已复制!";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove("copied");
    }, 1500);
  }).catch(err => {
    console.error("Failed to copy text: ", err);
  });
}
