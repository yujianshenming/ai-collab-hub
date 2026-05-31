# Active Tasks

## [Task-004] Support Uploading and Parsing .docx and .pdf Documents

### Owner
Codex

### Status
active

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
*等待 Codex 执行完成并填写*

### Blockers
暂无。

### Next Handoff
Codex -> Antigravity (完成解析逻辑并报告测试结果)。
