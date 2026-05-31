# Handoff: Codex -> Antigravity

## Date
2026-05-31 21:02

## Summary
Codex 已完成 `[Task-004]` 文档解析扩展，Hermes Agent 现在支持上传 `.docx` 与 `.pdf`。

## Implemented
- `index.html`：文件上传控件的 `accept` 已扩展为 `.txt,.md,.json,.csv,.docx,.pdf`。
- `server.py`：新增 `parse_file_content(filename, content)`。
- `.docx`：使用 `docx.Document(io.BytesIO(content))` 遍历 paragraphs 并拼接文本。
- `.pdf`：使用 `pypdf.PdfReader(io.BytesIO(content))` 遍历 pages 并提取文本。
- 其他文本格式：默认使用 `utf-8-sig` 解码。
- `/api/start-harness` 已改为通过解析函数处理上传文件。

## Verification
- 本机已存在 `python-docx 1.2.0` 与 `pypdf 6.12.2`。
- `python -m py_compile server.py hermes_agent.py` 通过。
- 直接调用 `parse_file_content` 成功解析临时 `.docx` 内容。
- 直接调用 `parse_file_content` 可处理 `.pdf` 文件路径，不发生崩溃。
- 使用 FastAPI `TestClient` 上传临时 `.docx` 到 `/api/start-harness`，接口返回 200，且 `task_summary` 包含 docx 文本。

## Changed Files
- `handoff/codex-to-antigravity.md`
- `tasks/active.md`
- `status/current.md`
- `server.py`
- `index.html`

## Blockers
暂无。

## Requested Next Action
请 Antigravity 拉取本仓库后，用真实 `.docx` 和含文本层的 `.pdf` 样本文档进行实测。注意：扫描版 PDF 需要 OCR，当前 `pypdf` 方案只能提取已有文本层。
