# 作业批阅方差集成

这是个人工作台内置的 Polymas / 智慧树作业批阅方差工具。它保留原项目的 Python 批阅引擎和 FastAPI 页面，由 Electron 主进程按需启动本地服务，再通过 iframe 放进工作台。

## 能做什么

- 对同一批作业执行多次独立 AI 批阅。
- 根据平台返回的评分产物计算均值和总体方差（除以 `n`）。
- 查看批阅进度、学生评分卡和历史任务。
- 导出评分表 Excel。
- 自动从作业 URL、JWT、Cookie 解析 `instance_nid`、`agent_id`、`course_id` 和 `user_nid`。
- 可选地调用 Polymas OpenAI-compatible 网关回填空答案。

## 在工作台中使用

1. 启动个人工作台，点击左侧「作业批阅方差」。
2. 首次进入时，工作台懒启动本地 Python 服务；它只监听 `127.0.0.1` 的动态端口。
3. 在批阅台中填写作业 URL、JWT / Cookie，上传作业文件并创建任务。
4. 批阅完成后，在工具内下载 Excel 评分表。

Python 解释器默认按 `python.exe`、`python`、`py -3` 顺序查找。依赖安装：

```powershell
python -m pip install -r integrations/homework-variance/requirements.txt
```

也可以设置 `PERSONAL_WORKBENCH_PYTHON` 指向明确的 Python 可执行文件。

## 数据与凭证边界

- 运行数据保存在 Electron `userData/homework-variance`，包括任务配置、上传文件、状态文件和 Excel；不写入代码目录。
- 平台 JWT / Cookie 由批阅台写入本机任务配置，仅用于该任务调用平台接口；不要提交到 Git。
- LLM 凭证不写入任务配置。引擎只读取环境变量 `POLY_LLM_API_KEY` 等，或用户数据目录下的 `homework-variance/secrets.json`。
- 仓库只保留 `secrets.example.json`，不包含真实 `secrets.json`。
- 服务 API 在工作台启动时使用随机访问令牌；没有令牌的 `/api/*` 请求返回 `401`。评分表下载使用短时 URL 参数，因为浏览器下载请求不能可靠附加自定义请求头。
- 应用退出时由主进程结束 Python 服务及其子进程。

## 独立调试

源码副本仍可独立启动，默认端口为 `8765`：

```powershell
python integrations/homework-variance/web_server.py
```

工作台启动时会显式传入 `--host 127.0.0.1`、动态 `--port`、`--data-root` 和 `--auth-token`。独立调试不传令牌时保持兼容，但不应把服务暴露到局域网或公网。

## 打包说明

`package.json` 的 `extraResources` 会把集成源代码放到打包应用的 `resources/integrations/homework-variance`。便携包不会自动捆绑 Python 解释器和第三方依赖，目标机器需要安装 Python 3.10+ 并安装 `requirements.txt`；后续如果要实现完全免安装分发，应另行引入固定 Python runtime 和依赖封装，不在本次集成中隐式扩大范围。
