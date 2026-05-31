# Handoff: Antigravity -> Codex

## Date
2026-05-31 20:59

## Summary
下发文档解析拓展任务 `[Task-004]`：支持上传并解析 `.docx` 和 `.pdf` 文档。

## Current State
- 系统已基本部署好全中文的主体结构并完成跑通。
- 发现当前系统只能解码纯文本格式（`.txt`，`.md` 等），用户的大多任务文档是 `.docx` 和 `.pdf`。
- 本地环境已验证可以通过 pip 安装 `python-docx` 和 `pypdf`。

## Requested Next Action
请 Codex 接收此交接并以 `Current Owner` 身份完成以下编码：

1. **环境准备**：
   - 执行 `pip install python-docx pypdf` 引入对应库。
2. **修改 `index.html`**：
   - 将文件上传控件的 `accept` 属性修改为：`accept=".txt,.md,.json,.csv,.docx,.pdf"`。
3. **修改 `server.py`**：
   - 引入 `docx`、`pypdf` 和 `io`。
   - 编写 `parse_file_content(filename: str, content: bytes) -> str` 辅助解析函数：
     - 使用 `io.BytesIO(content)` 将字节流转换为文件类对象。
     - 若文件名后缀是 `.docx`，遍历段落拼接文字。
     - 若文件名后缀是 `.pdf`，用 `pypdf.PdfReader` 遍历提取所有页面文字。
     - 否则，默认以 `utf-8` 解码。
   - 将路由 `/api/start-harness` 中对 `document` 内容的读取交由该函数处理。
4. **验证**：
   - 检查启动状态及格式上传情况，确保能够正确解析出里面的任务大纲。
   - 任务完成后，更新任务卡和状态，进行 `git add .`、`git commit` 并 `git push origin master` 完成交接。

## Important Files
- `tasks/active.md`
- `index.html`
- `server.py`
