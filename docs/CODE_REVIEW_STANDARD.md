# 代码审查标准（Code Review Standard）

> 适用范围：本仓库所有合入 `master` 的变更，含 Python（`server.py` / `hermes_agent.py` / `integrations/`）与前端（`personal-workbench/`，Electron + JS/TS）。
> 维护者：代码审查负责人（Antigravity / 指定人类 reviewer）。最近更新：2026-07-30。
> 配套文档：[CODE_REVIEW_PROCESS.md](CODE_REVIEW_PROCESS.md)（流程）、[../.github/PULL_REQUEST_TEMPLATE.md](../../.github/PULL_REQUEST_TEMPLATE.md)（PR 模板）、`personal-workbench/regression-checklist.md`（前端安全回归清单）。

---

## 1. 为什么需要这份标准

本仓库是多 AI 实例（Antigravity / Codex）+ 人类 + 多机器协作的项目。质量参差不齐的主要来源已经定位：

- **前端 `personal-workbench/`** 已有不错的纪律（`regression-checklist.md`、`AGENTS.md`、20+ 单测、Playwright e2e），但**依赖人工执行**，没有强制门禁。
- **Python 侧（`server.py` / `hermes_agent.py` / `integrations/`）目前零测试、零 lint、零类型检查**，且存在多处真实隐患（见 §5 案例）。

这份标准的目标：让"什么是好代码、什么必须打回"变成**可对齐、可复用、可机器校验**的清单，而不是每个人的主观感觉。

---

## 2. 严重级别定义

每条审查意见必须带一个级别标记，使用统一 emoji + 英文标签，便于检索与统计：

| 级别 | 标记 | 含义 | 合并前要求 |
|------|------|------|-----------|
| 阻断 | 🔴 Blocker | 安全漏洞、数据损坏/丢失、崩溃、破坏 API 契约、绕过既有安全边界 | **必须修复**，否则禁止合入 |
| 主要 | 🟡 Major | 明显正确性问题、未验证输入、关键路径缺测试、性能瓶颈、严重可维护性差 | **应修复**；若确有例外，须书面说明理由并建 issue 跟踪 |
| 次要 | 💭 Minor/Nit | 命名、注释、风格、小优化 | 可后续处理，建议建 issue 或就地修 |

> 规则：🔴 数量 > 0 的 PR 一律打回；🟡 需逐条解决或留痕；💭 不阻塞合入，但应被礼貌地指出。

---

## 3. 通用审查维度（五条主线）

无论哪种语言，都按这五个维度过一遍：

1. **正确性（Correctness）**——是否真的做了它该做的事？边界条件、空值、异常路径都覆盖了吗？
2. **安全性（Security）**——注入（SQL/命令/模板）、XSS、鉴权绕过、密钥泄露、路径穿越、越权访问？
3. **可维护性（Maintainability）**——半年后的人看得懂吗？命名清晰？没有超大函数/复制粘贴/魔法数字？
4. **性能（Performance）**——明显的瓶颈？每次请求都写盘？N+1 查询？无上限的大对象？
5. **测试（Testing）**——重要路径有测试吗？纯函数有单测吗？破坏性改动有回归证据吗？

---

## 4. 分语言检查清单

### 4.1 Python（FastAPI / urllib / 本地脚本）

**安全性**
- [ ] 密钥（API key）只存在于主进程，不出现在任何 IPC 返回值、`print`、日志、异常信息中（`hermes_agent.py` 从 `config.json` 读取明文 key，review 时确认没有回显）。
- [ ] 文件读取/写入做路径校验，禁止路径穿越（`server.py:parse_file_content` 处理上传文件；`integrations/` 的 `serveFile`/`file-action` 类接口）。
- [ ] 外部输入（上传大小、`threshold`、LLM 返回的 JSON）有边界校验与上限，不接受无限大的负载。
- [ ] LLM 返回内容视为**不可信输入**：解析前清洗、字段缺失有默认值、不把模型输出直接当可信数据落库或执行。

**正确性**
- [ ] 网络调用对空/异常响应有守卫：`data["choices"][0]["message"]["content"]`（`hermes_agent.py:112`）在 `choices` 为空时会 `KeyError`/`IndexError`，需先判空。
- [ ] 异常处理**不能吞掉真实错误**：`hermes_agent.py:113` 的 `except Exception` 把超时、5xx、JSON 错误全转成 mock 静默降级，会掩盖故障——应区分"可恢复的降级"与"需要上报的失败"。
- [ ] 解析失败不要硬编码"假的好结果"：`Evaluator.evaluate`（`hermes_agent.py:658`）解析失败时返回固定 75 分，会粉饰模型坏输出——应标记为失败/降级并留痕。
- [ ] 魔法数字要有名字：`for index in range(1, 3)`（`hermes_agent.py:762`，最多 2 轮优化）、`max_exchanges = 15`（`hermes_agent.py:487`）应提取为具名常量或配置项。

**性能**
- [ ] 不在每次请求做无谓的磁盘 I/O：`server.py:62-70` 无条件把输入写到 `debug_input.txt`，在高并发/隐私场景有性能与泄露风险——应受环境变量/开关控制，且限制写入大小。
- [ ] 上传文件、LLM 响应有大小上限，避免内存爆掉。

**可维护性**
- [ ] 函数长度可控；`HermesAgent.run` / `AgentSandbox.simulate` 这类大函数建议拆出可单测的小函数。
- [ ] dataclass 的可选字段用 `field(default_factory=...)` 而非可变默认值（当前已正确，保持）。

**测试（当前最薄弱项，重点要求）**
- [ ] 纯函数必须有单测：`normalize_dialogue_output`、`get_card_transition_word`、`compile_card_prompt`、`parse_file_content`、`summarize_document`。
- [ ] 端点必须有集成测试：`/api/start-harness` 用 FastAPI `TestClient` 覆盖"无文档 / 有文档 / 非法后缀 / 超大上传"等路径。
- [ ] 配置缺失、网络失败、LLM 返回畸形 JSON 等异常路径有测试，且断言"失败被显式暴露"而非"静默降级"。

### 4.2 JS / Electron（`personal-workbench/`）

前端已有成熟清单，**审查时直接复用并核对**，不在此重复：

- **静态对账（必查）**：`regression-checklist.md` §0.1 —— `npm run check`、`DOM 对账`（renderer 的 `elements` 映射 ↔ `index.html` id）、`IPC 三端对账`（`main.js` ↔ `preload.js` ↔ `renderer.js` 通道名一致）、新增事件监听目标真实存在。
- **安全四项（每次交付必测，不得回退）**：`regression-checklist.md` §6 —— composedPath 外点关闭、Token 注入白名单、静态服务路径穿越、`temp/tasks` IPC 防穿越、本地 HTTP API 鉴权。
- **AI 网关安全边界（必查）**：`regression-checklist.md` §7.2 —— API key 只驻主进程、Base URL 固定、`ai:get-config` 不回明文/密文、密钥不进 git。
- 新增 IPC 通道、扩展权限、Token 注入、路径处理、下载/上传注入时，**必须同时补安全回归证据**，并在 PR 模板"安全影响"一节说明。

补充通用项：
- [ ] `contextIsolation` 为真、`nodeIntegration` 为假（Electron 安全基线）。
- [ ] 不在渲染进程拼接并执行命令；所有敏感操作走主进程 IPC。
- [ ] 不把 `secrets.json`、`weekly_tasks.json`、`llm-secret.bin`、Cookie、Token 提交进 git（见 `AGENTS.md`）。

---

## 5. 真实代码案例（来自本仓库，作为标准注解）

下面这些不是"挑刺"，而是把标准落到你们自己的代码上，方便 reviewer 对照。

| # | 级别 | 位置 | 问题 | 标准条款 |
|---|------|------|------|---------|
| C1 | 🔴 | `hermes_agent.py:112` | `data["choices"][0]["message"]["content"]` 未判空，空 `choices` 时崩溃 | §4.1 正确性 |
| C2 | 🟡 | `hermes_agent.py:113-116` | 裸 `except Exception` 把所有失败静默转 mock，故障不可见 | §4.1 正确性/可维护性 |
| C3 | 🟡 | `hermes_agent.py:658-670` | 评估 JSON 解析失败返回硬编码 75 分，粉饰坏输出 | §4.1 正确性 |
| C4 | 🟡 | `server.py:62-70` | 每次请求无条件写 `debug_input.txt`，性能+隐私风险 | §4.1 性能/安全 |
| C5 | 💭 | `hermes_agent.py:762, 487` | `range(1,3)`、`max_exchanges=15` 魔法数字 | §4.1 可维护性 |
| C6 | 🟡 | `server.py:53` + `start_harness` | 上传文件无大小上限校验 | §4.1 安全/性能 |

> 这些案例会随评审推进逐步清零；清零后在 `regression-checklist.md` 附表或本文件登记"已修复"，不要留成僵尸条目。

---

## 6. 安全红线（硬性，违反即 🔴）

以下任一条违反，**直接打回**，无例外：

1. 密钥/Token 出现在代码、日志、IPC 返回值或 git 历史。
2. 路径穿越（任意 `../`、绝对路径越界访问 `temp/tasks` 或 `userData` 之外）。
3. 未鉴权的本地 HTTP API（§6 列出的 `/cookies /events /state /tabs` 等无 token 必须 401）。
4. 普通外网 webview 能拿到完整 session token（应为 per-tab 受限 token）。
5. 破坏现有 IPC 三端一致性或 DOM 映射一致性。
6. 未经验证的 LLM 输出被当作可信数据直接落库/执行。

---

## 7. 统一评审注释格式

每条意见用如下格式，便于作者快速定位与统计：

```
🔴 **[正确性] choices 为空时崩溃**
位置：hermes_agent.py:112
为什么：当网关返回空 choices（限流/模型下线）时，`data["choices"][0]` 抛 IndexError，
       当前被上层 except 吞掉并静默降级，故障无人知晓。
建议：先判 `if not data.get("choices"): return self._mock_response(...)`（或显式报错），
     再取 `data["choices"][0]["message"]["content"]`。
```

好代码也要点赞：发现巧妙的抽象、干净的错误处理、补了安全回归测试，请明确写一句 👍 肯定——审查不是只有挑错。

---

## 8. 与现有协议的关系

- 本标准是 `PROTOCOL.md` 中"Antigravity 审查 Codex 执行结果"环节的具体落地细则。
- 前端安全回归以 `personal-workbench/regression-checklist.md` 为权威清单，本标准 §4.2 引用之，不另起炉灶。
- 维护纪律以 `personal-workbench/AGENTS.md` 为准（改前读手册、补测试、跑 `npm run test:all`、不提交个人数据）。
