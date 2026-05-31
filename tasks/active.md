# Active Tasks

## [Task-003] Implement PromptHarness Core System (Backend & Frontend)

### Owner
Codex

### Status
active

### Context
需要开发一套自动生成、模拟和评估提示词（Persona）的闭环优化系统。系统由 Python 后端和 Web 可视化前端构成。

### Goal
编写 `prompt_harness.py`、`server.py` 以及 Web 静态资源文件，实现整个 Agentic Loop 并能够通过 Web 界面进行交互。

### Requirements

#### 1. 后端核心逻辑 (`prompt_harness.py`)
- **API 兼容性**：设计一个通用的 LLM 调用封装，支持检测环境变量 `GEMINI_API_KEY` 或 `OPENAI_API_KEY`。若未配置任何 Key，应提供一个高水准的 **Mock LLM 引擎**，模拟生成、模拟对话及打分，以确保系统在断网/无 Key 时也能流畅演示。
- **提示词生成器 (Generator)**：解析上传的任务文档，生成特定角色（Trainer）的 System Prompt。
- **对话模拟器 (Simulator)**：自动生成一个与之匹配的学生角色（Student），进行 3-5 轮的多轮对话仿真，输出 Transcript。
- **评估引擎 (Evaluator)**：对 Transcript 进行打分（0-100分），评估对话达成率，并输出诊断报告（包括改进意见）。
- **优化器 (Refiner)**：若打分低于 85 分，自动根据 Evaluator 的意见修改 System Prompt，进行第二轮仿真。

#### 2. FastAPI 服务端 (`server.py`)
- 提供 API 路由：
  - `/api/start-harness` (POST)：接收上传的文档，开始整个生成与仿真评估循环，返回每一步的实时状态与最终结果。
  - 静态文件挂载：将仓库根目录下的前端静态资源挂载为静态文件服务。

#### 3. Web 可视化前端 (`index.html`, `style.css`, `app.js`)
- **设计美学**：使用深色/玻璃渐变等高阶 CSS 视觉效果。
- **功能模块**：
  - 左侧：上传文档与配置区（配置阈值、选择学生人设）。
  - 中间：多智能体模拟对话展现区（气泡聊天框形式，实时渲染老师和学生的对话）。
  - 右侧：打分仪表盘与优化反馈报告区。

### Plan
1. Codex 编写 `prompt_harness.py`，实现基本模块。
2. 编写 `server.py` 暴露 API 并处理静态文件。
3. 编写 `index.html`、`style.css` 和 `app.js` 编写现代前端界面。
4. 验证并本地运行 `python server.py`。
5. 成功后，提交更新并更新任务状态。

### Result
*等待 Codex 执行完成并填写*

### Blockers
暂无。

### Next Handoff
Codex -> Antigravity (完成全部编码并报告测试地址)。
