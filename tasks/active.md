# Active Tasks

## [Task-004] Support Uploading and Parsing .docx and .pdf Documents

### Owner
Codex

### Status
done

### Context
目前系统仅支持 `.txt` 和 `.md` 格式的文本文件。用户很多任务文档是以 `.docx` 或 `.pdf` 格式保存的，系统应当支持这两种文件格式的解析。

### Goal
在后端实现 `.docx` 和 `.pdf` 文件的文本提取逻辑，并在前端放开文件类型上传限制，确保系统能顺利解析多格式文档。

### Requirements
1. **依赖库安装**：在目标电脑上使用 `pip install python-docx pypdf` 引入对应解析包。
2. **前端修改**：更新 `index.html` 中的文件上传 input 控件，使其 `accept` 属性支持 `.docx` 与 `.pdf`。
3. **后端解析逻辑**：
   - 在 `server.py` 中引入 `docx` 和 `pypdf`，并提供文件解析函数 `parse_file_content(filename, content)`：
     - 若为 `.docx`：将 bytes 用 `io.BytesIO` 包装后，利用 `docx.Document` 遍历 paragraphs 并以 `\n` 连接。
     - 若为 `.pdf`：利用 `pypdf.PdfReader` 读取所有 pages，合并其中的文字。
     - 若为其他格式，默认采用 `utf-8` 解码。
   - 在 `/api/start-harness` 路由中，读取上传文件并调用解析函数。
4. **验证**：确保能够成功上传 `.docx` / `.pdf` 文件进行仿真，不发生解码报错或崩溃。

### Plan
1. Codex 在本地执行 `pip install python-docx pypdf` 安装依赖。
2. 修改 `index.html` 使其允许上传相应扩展名。
3. 在 `server.py` 中引入 `docx`、`pypdf` 和 `io` 并编写 `parse_file_content` 逻辑。
4. 替换原本的 utf-8 简单解码，将上传的文件字节流传入该解析函数。
5. 启动测试，成功后提交更改、更新任务卡并交接。

### Result
Codex 已完成 Task-004：

- 本机已存在 `python-docx 1.2.0` 与 `pypdf 6.12.2`，无需重复安装。
- 已更新 `index.html` 的上传控件，支持 `.txt,.md,.json,.csv,.docx,.pdf`。
- 已更新 `server.py`：
  - 引入 `io`、`docx`、`pypdf`。
  - 新增 `parse_file_content(filename: str, content: bytes) -> str`。
  - `.docx` 使用 `docx.Document(io.BytesIO(...))` 遍历 paragraphs 提取文本。
  - `.pdf` 使用 `pypdf.PdfReader(io.BytesIO(...))` 遍历 pages 提取文本。
  - 其他格式默认使用 `utf-8-sig` 解码。
  - `/api/start-harness` 已改为通过 `parse_file_content` 处理上传文件。
- 验证通过：
  - `python -m py_compile server.py hermes_agent.py`
  - 直接调用 `parse_file_content` 成功解析临时 `.docx` 内容。
  - 直接调用 `parse_file_content` 可处理 `.pdf` 文件路径，不发生崩溃。
  - 使用 FastAPI `TestClient` 上传临时 `.docx` 到 `/api/start-harness`，接口返回 200，且 `task_summary` 包含 docx 中的任务文本。

### Blockers
暂无。

### Next Handoff
Codex -> Antigravity (已完成解析逻辑并报告测试结果)。
