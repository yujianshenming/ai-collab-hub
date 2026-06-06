# Done Tasks

已完成任务。

## [Task-001] 初始化协作仓库结构

### Owner
Antigravity

### Context
用户指令启用 AI 协作协议。

### Goal
建立协作协议要求的文件结构，包括 status、tasks、handoff 等目录。

### Result
文件结构创建完毕，已复制 PROTOCOL.md，并更新了 status/current.md。

## [Task-002] Setup and Automate Antigravity IDE Configuration Sync

### Owner
Codex

### Context
根据 `e:\antigravity_sync_instructions.md` 手册，需要实现多台电脑间 Antigravity IDE 配置文件夹（`C:\Users\<Username>\.gemini\antigravity`）的 Git 同步。

### Goal
在 Codex 运行的新机器上初始化配置同步，并编写自动化脚本以安全地拉取和推送配置状态（需检查并确保 IDE 已关闭）。

### Result
- 已确认配置目录为 `C:\Users\24391\.gemini\antigravity`，且其已初始化为 Git 仓库并指向 `antigravity-config.git`。
- 已编写安全同步脚本 `sync_pull.ps1` 和 `sync_push.ps1`，脚本包含进程（`antigravity` 和 `gemini`）运行检测，若运行则自动中止以防冲突。
- 脚本语法及安全拦截已通过验证。后续只需在完全关闭 Antigravity 后，双击/运行脚本即可安全同步。

## [Task-003] Implement Hermes Agent Core System (Backend & Frontend)

### Owner
Codex / Antigravity

### Context
开发基于公司 API 密钥与 GPT-5.4/5.5 模型的提示词自动生成、沙箱模拟和评估闭环优化系统（Hermes Agent）。

### Goal
编写安全配置保护 `.gitignore`、API 连接模块、多轮模拟沙箱、智能评估打分引擎、FastAPI 后端以及精致的 Web 可视化前端。

### Result
- 已成功在本地编写并配置了忽略 `config.json` 的安全 `.gitignore` 规则。
- `hermes_agent.py` 与 `server.py` 完整实现，已测试接入公司 `gpt-5.4` 模型。
- 通过测试脚本 `test_hermes.py` 完整测试了从 **文档输入 -> 提示词生成 -> 3轮Trainer与Student模拟对话 -> 模型多维度打分评估与自愈** 的全流程。
- 前端 Web 主页和接口调试完毕，全系统就绪，模型能够基于实际公司凭证输出高水平的仿真对话和精确评估报告。

## [Task-004] Support Uploading and Parsing .docx and .pdf Documents

### Owner
Codex

### Context
用户需要将 `.docx` 和 `.pdf` 格式的论文/任务文档上传并直接转换为文本进行评估与仿真。

### Goal
安装解析依赖包，在前端开放 `.docx` 和 `.pdf` 上传限制，并在后端提供对 `.docx`（python-docx）与 `.pdf`（pypdf）文件的自动提取解析。

### Result
- 已安装 `python-docx` 和 `pypdf` 依赖包。
- 修改了 `index.html`，使文件选择控件的 `accept` 允许上传 `.docx` 与 `.pdf` 扩展名。
- 在 `server.py` 中实现了 `parse_file_content(filename, content)` 处理函数，可以从上传的文件字节流中读取解析出文字内容，并应用于仿真评估中。
- 前后端对接并通过功能测试，验证可用。

## [Task-005] Handle Large Document Uploads Safely (Truncation Guardrail)

### Owner
Antigravity

### Context
在上传大型论文/任务文档时，接口因为请求体过大或超时触发大模型 API 网关拒绝连接，返回 500 错误。

### Goal
在后端将输入文档内容截断到安全长度（15,000 字符内），防止 API 传输失败，保障系统的稳定性。

### Result
- 已在 `hermes_agent.py` 的 `PromptGenerator.create_trainer_prompt` 接口中为输入文档增加了 15,000 字符的截断上限。
- 该处理既保留了论文的大纲与核心篇幅，又确保了大模型 API 连接的稳定性，本地大文件上传仿真测试验证已通过。

## [Task-008] 支持动态提取标识词与对话神态过滤优化

### Owner
Antigravity

### Context
通过对桌面上 12 个高校/课程真实任务与提示词模版的分析，发现不同任务的阶段切档词（如“下一阶段”、“下一板块”、“Next”、“训练结束”）差异大，且仿真模拟过程中常常出现 `*点头*`、`*微笑*` 等物理/神态描写，不够贴合纯对话模式。

### Goal
1. 支持在大模型分析任务文档时动态提取标识词（Transition Word），并在仿真沙箱中精准匹配传递。
2. 在 System Prompt、导师提示词模板、学生沙箱及自愈优化器中增加严格的只输出台词对话、消除动作神态描写的控制机制。
3. 前端界面自动同步大模型分析出来的阶段跳转词。

### Result
- 修改了 `hermes_agent.py` 中 `TaskAnalyzer.analyze_task` 的 JSON 格式大纲，由大模型根据文档提取 `transition_word`；
- 更新了卡片提示词编译、导师提示词生成器、学生沙箱和自愈优化逻辑，均加入禁用动作神态描写的 Rule/Constraint；
- 更新了 `static/app.js`，在 API 响应返回后自动将界面上的标识词输入框同步为大模型解析所得的词；
- 编写测试脚本以真实脑卒中实训 docx 文档运行测试，证明仿真对答完全去除了动作神态噪音，切档机制精准稳定。

