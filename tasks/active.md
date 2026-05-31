# Active Tasks

## [Task-003] Implement Hermes Agent Core System (Backend & Frontend)

### Owner
Codex

### Status
active

### Context
需要开发一套名为 **Hermes Agent** 的提示词自动评估与仿真优化系统。使用用户公司的 API Key 与 GPT-5.4 或 GPT-5.5 模型来驱动生成、模拟对话及评估。

### Goal
创建 `.gitignore`、`config.json`，并编写 `hermes_agent.py`、`server.py` 以及 Web 静态资源文件，实现基于 GPT-5.4/5.5 的闭环提示词评估系统。

### Requirements

#### 1. 安全防护
- **`.gitignore`**：必须创建，包含 `config.json`，确保含有敏感 Key 的本地配置文件不被 push 到公共 GitHub 仓库。
- **`config.json`**：存放在本地，包含以下配置：
  ```json
  {
    "api_key": "sk-Mir94j0bCmH6wOaPMwT8gr6O7iFk0zp9Z9sORgFoPjVB6SFO",
    "base_url": "http://llm-service.polymas.com/api/openai/v1",
    "model": "gpt-5.4"
  }
  ```

#### 2. 后端核心逻辑 (`hermes_agent.py`)
- **API 集成**：使用 OpenAI SDK（或 Python 的 `requests` / `urllib` 库直接调用 API，但安装并使用 `openai` 库最标准）连接公司端点，使用 `gpt-5.4` 或 `gpt-5.5` 模型。
- **提示词生成器 (Generator)**：解析输入的任务文档，生成 Trainer 提示词。
- **人设模拟器 (Simulator)**：自动生成一个测试用的 Student 提示词，并调用模型在沙箱中进行 3-5 轮对话。
- **评估引擎 (Evaluator)**：分析对话历史，自动从文档中提炼评估标准，给出打分（0-100）和诊断修改意见。
- **自适应优化 (Optimizer)**：如果得分不合格（例如 < 85分），结合评估建议重新生成/修改 Trainer 提示词，并再次进行对话仿真，直至合格或达到最大迭代次数（如2次）。

#### 3. FastAPI 后端 (`server.py`)
- 提供启动评估流的 API 接口 `/api/start-harness`。
- 挂载静态文件以服务前端。

#### 4. 可视化 Web 前端
- `index.html`, `style.css`, `app.js`：三栏卡片式布局（配置区、聊天气泡渲染区、评分和分析面板），展示精致的暗黑系视觉设计。

### Plan
1. Codex 编写 `.gitignore` 保护敏感配置。
2. 编写 `config.json` 存储 API 密钥与模型。
3. 编写 `hermes_agent.py` 实现后端生成与模拟打分环路。
4. 编写 `server.py` 提供 API 并挂载静态前端。
5. 编写前端三剑客资源。
6. 本地运行并推送非敏感代码，移交状态。

### Result
*等待 Codex 执行完成并填写*

### Blockers
暂无。

### Next Handoff
Codex -> Antigravity (完成全部编码并报告测试地址)。
