# 我知道的所有 Agentic Engineering 技巧（2026 年 6 月）

作者: Datawhale

公众号: Datawhale


# Datawhale干货

******作者：Matt Van Horn， 整理：Datawhale******

三个月前，Matt Van Horn 的《我知道的所有 Claude Code 技巧》在 X 上爆火。就在刚刚，他发布的新帖《Every Agentic Engineering Hack I Know》也很快被超 60 万人观看。

![image](image_01.png)

他是一位连续创业者，今年发布了 last30days（2.7 万星）、Printing Press（4000+ 星），并成为了一些最大开源项目的顶级贡献者：Python、Go、GStack 和 Paperclip。

而这一身经验，他最后都浓缩成了关于 Agentic Engineering 的22 条心得。

在保留其中可复用的命令、工具名、场景和原意的情况下，我们进行了如下整理：

## 一、先规划，再动手

### 01｜有想法，先
```
/ce-plan
```
，不要直接开干

脑子里冒出一个想法，第一反应：
```
/ce-plan
```
生成
```
plan.md
```
。它接什么上下文都行：

* GitHub issue 链接直接贴进去；
* 终端报错，
```
Cmd+Shift+4
```
截图，
```
Ctrl+V
```
粘进去；
* 设计稿、Slack 讨论串、产品脑暴图，也都能喂进去；
* 如果想法还很模糊，先用
```
/ce-brainstorm
```
把问题聊清楚，再进
```
/ce-plan
```
。

把模糊想法先外化成一个计划文件，再往下走。

### 02｜
```
plan.md
```
是给 agent 看的，自己扫一眼标题就够

原文里直接说： **"Plans are for agents, you silly human."**

```
plan.md
```
逼 agent 先 research、先承诺方案、写清 acceptance criteria，然后别偷懒，真的把它做完。他还给过一个比喻： **"The plan is the leash."** 没计划的 agent 容易抄近路、提前停工；有计划才能按完整交付往下做。

实际操作就是：看一眼标题，直接
```
/ce-work
```
。真有不懂的地方，在会话里追问
```
TLDR?
```
、
```
eli5 this plan
```
，或者“等一下，为什么选这个方案？”

### **03｜不限于写代码，重度脑力工作也用同一条 loop**

```
/ce-plan
```
和
```
/ce-work
```
用在非工程类工作上同样顺手：

* 战略文档；
* 产品 spec；
* 竞品分析；
* board update；
* 复杂讨论后的整理与提案。

做法是：先别直接写最终文档，先让 agent 规划这件事需要哪些输入、哪些角度、先做什么研究、怎么组织输出。复杂问题先降成可执行的 planning problem。

## 二、怎么把活高效喂给 agent

### **04｜语音做主输入**

```
voice-to-LLM
```
和传统语音转文字不一样：对面是大模型，能靠上下文把你含糊、重说、卡壳的部分补回来。

配置参考：

* Mac 上用
```
Monologue
```
或
```
Wispr Flow
```
；
* 手机上直接用 Apple 自带听写，因为 iOS 来回切 App 太慢；
* 办公桌上配一个鹅颈麦。

### 05｜同时开 4 到 6 个
```
cmux
```
会话

日常状态：

* 一个在写 plan；
* 一个在按另一个 plan build；
* 一个在跑
```
last30days
```
做研究；
* 一个在修刚测出来的 bug。

一个窗口里的
```
/ce-plan
```
在研究时，切到另一个窗口
```
/ce-work
```
；第二个在执行，又把第三个 bug 塞进去。整个变成多线程调度 agent。

### **06｜新终端标签页默认直达 Claude Code**

一个新 tab 打开后如果还要
```
cd
```
、手敲
```
claude
```
，启动 agent session 的成本还是高。做法是把终端默认入口改掉，新 tab 一开就是 Claude Code。Ghostty 下可以通过 launcher 脚本把新窗口的默认命令直接接到 Claude Code。文件夹层级基本可以不依赖了，因为 agent 会自己找项目。

### **07｜远程控制 + 邮箱入口**

在
```
~/.claude/settings.json
```
里加上：

```
"remoteControlAtStartup": true
```

电脑上开的 session，手机 Claude App 也能接着看、接着控。人在外面排队，家里 Mac 上的任务还在跑，掏手机就能继续接管同一个上下文。

再给 Claude Code 配一个邮箱（用的是
```
AgentMail
```
），给这个邮箱发邮件就等于给 agent 新开了一个任务入口。

### **08｜跳过权限确认**

同时跑 6 个 agent 会话，不可能一个个去点"允许修改""允许执行命令"。Claude 配置里直接打开：

* defaultMode: bypassPermissions
* skipDangerousModePermissionPrompt: true

再配上
```
WebSearch
```
、
```
WebFetch
```
、
```
Bash
```
、
```
Read
```
、
```
Write
```
、
```
Edit
```
的 allow 列表。原文里他的说法是： **"Maybe. I say YOLO. It's my computer. GitHub is there if I break everything."**

### **09｜Claude 管 plan，Codex 管 build**

三种交接方式：

1. Codex IDE extension：任务发过去，结果应用回来；

2.
```
/ce-work --codex
```
：在 Compound Engineering 的 loop 里委托给 Codex；

3. Printing Press 的 Codex 模式：prompt 结尾加
```
codex
```
。

参数偏好：

* Codex：
```
reasoning xhigh
```
，
```
fast mode on
```
；
* Claude Code：
```
reasoning xhigh
```
，
```
fast mode off
```
。

## 三、agent 强不强，看你喂了多少上下文

### 10｜
```
/ce-plan
```
之前，先跑一遍
```
/last30days
```

这是 Matt 自己的开源项目，用法是：先研究，再计划。

例子：在 Vercel 的 agent-browser 和 Playwright 之间做选择，他没先读文档，直接跑：

```
/last30days Vercel agent browser vs Playwright
```

几分钟内 Reddit、X、YouTube、HN 等平台的讨论被并行抓回来。结果是 agent-browser 每次调用吃掉的上下文更少，而 Playwright 光工具定义就灌进去几千 token。再把这批结果喂给
```
/ce-plan integrate agent-browser
```
，做出来的 plan 直接站在社区最近 30 天的真实经验上。

```
last30days
```
会并行搜索 Reddit、X、YouTube、TikTok、Instagram、HN、Polymarket、GitHub 和整个 Web。使用时机：选库之前、做 feature 之前、见合伙人之前、写文章之前。

### **11｜会议别自己总结，原始 transcript 直接扔进去**

和候选人吃午饭聊了 90 分钟，有产品、有吃的、有孩子，中间夹着产品想法。
```
Granola
```
全程录音。结束后不整理，直接把完整 raw transcript 扔进 Claude Code：

```
/ce-plan turn this into a product proposal
```

不要先"替模型总结一遍"。原始对话里的跑题、停顿、插科打诨，模型会自己判断哪些留下、哪些忽略。说法是：Granola 原始记录 + 当前代码库 + 之前所有战略文档一起喂进去，那份 proposal 当晚就能发出。

### **12｜同时跑多个 agent 时，你负责给信号**

原文标题叫 **Human Signal** ：agent 提供产量，人提供品味、方向和 react-and-redirect。要做的是不断给出反馈：

* "第二版更接近了，但把第一版的语言拿回来"
* "先处理最大的风险"
* "这一段太长了"
* "这个方向不对，换个角度"

原文原话： **agents supply volume, you supply taste.**

### **13｜视频也走同一条 loop**

用
```
HyperFrames
```
：先写 HTML/脚本，再让 agent 渲染成 MP4。

* 一个项目一个文件夹；
* 里面一个
```
script.md
```
；
* 每一幕、动效、字幕节奏都写清楚；
* 交给 agent 生成最终 composition 和视频。

做过
```
Granola CLI
```
demo、
```
Agent Cookie
```
launch video 之类的内容。小技巧：GIF 上传到 catbox，在 GitHub PR、README 和 issue 里渲染都很好。

### **14｜笔记做成 agent 的知识库**

plan 越做越好，是因为 agent 一直能读到过去的计划、会议、留下的判断。

可用的工具：

* Bear + Bear CLI：十年笔记、会议、半成型想法、决策记录，可读写；
* Obsidian：生态很深；
* gbrain：跨机器、跨 agent 同步；
* supermemory：agent memory layer。

核心动作：找一个带 CLI 或 API 的笔记系统，让 agent 能读进去。本质是 Personal RAG。

### **15｜"随时随地工作"背后是一台 Mac mini 和几台远程机器**

不是手机上看一眼通知的那种 remote，是把整台工作台带上。

* Mosh 抗差网，Wi-Fi 不稳或漫游时比普通 SSH 稳得多；
* tmux 抗断线，飞机上断网 20 分钟连回来接着干；
* Hermes、OpenClaw 做更自治的远程工作；
* Agent Cookie 在主力 Mac 和 Mac mini 之间同步 cookies 和
```
.env
```
。

从欧洲回程的飞机上就是这么一路把 feature 发完的。

## 四、让 agent 走出终端，接管真实工作

### 16｜
```
plan.md
```
给 agent 看，
```
Proof
```
给同事看。

```
plan.md
```
在终端里好用，直接拿给同事看不顺手。把
```
plan.md
```
或 spec 丢进
```
Proof
```
，生成一个链接：

* 同事像看文档一样看；
* 可以做 inline comment；
* 评论能再流回 agent loop。

比把 Markdown 粘到 Slack 里强。

### **17｜任何做超过两次的事，写成 skill**

原文： **Anything I do more than twice, I turn into a skill.**

不建议从零写 skill。直接对 agent 说：

```
look at the Compound Engineering skill and help me make one like this for [X]
```

让它先读一个跑通的 skill，再照着 scaffold 你的版本。一次性 workflow 变成 agent 能长期复用的命令。

### **18｜开源贡献放进同一条 loop**

已有数百个 PR 被合并进不同开源项目，做的都是正经功能。涉及的项目包括 Python、Go、OpenCV、Vercel Agent Browser、OpenClaw 等。在一些项目的贡献者榜单里排名靠前：Compound Engineering / Superpowers / Emdash #3，GStack / Paperclip #4，Vercel Agent Browser #6，Camoufox #2。

做法：先找一个自己每天真的在用的工具，发现真实缺口，用
```
/ce-plan + /ce-work
```
补掉。

两个社交方面的建议：

* 去项目的 Discord 里出现，PR 只是进门，关系才是留下来的原因；
* 在 X 上花 1-3 美元/月订阅你尊重的人。他订阅
```
@garrytan
```
、
```
@jason
```
、
```
@teknium
```
，给
```
@garrytan
```
发带 PR 的帖子时，因为自己是付费订阅者，对方会收到特殊通知。

### **19｜M5 Max + 64GB RAM 也扛不住**

之前两年旧的 laptop 被跑废：6 个 Claude 会话 + Codex 全天挂着。升级到 M5 Max、64GB RAM，还是被打爆。全新机器电池状态下最夸张只撑一个小时。应对：

* 到处背一个 Anker battery brick；
* Tesla 里常备 Anker 车载充电器；
* ```
sudo pmset -a disablesleep 1，直接不让机器休眠。
```

### **20｜Printing Press：给真实世界服务做一层 CLI**

很多服务只在网页里手动点点点，把这些动作包装成 agent 能直接调用的 CLI。这个项目叫
```
Printing Press
```
，现在是独立项目
```
@ppressdev
```
。

难点在认证。agent 光知道服务没用，得带着你的登录态去操作。配套组件是 **Agent Cookie** ：把真实浏览器的 session 交给 CLI，让 agent 直接带着登录态行动。

能处理的不只是 GitHub issue 和代码库，还包括生活和工作服务，比如给 Tesla 预热这种。原文的判断是：工作方式会不会变，很大程度取决于能不能把自己每天在用的服务印成 agent 可调用的接口。

## 五、最后两条提醒

### **21｜Agent 很容易上瘾。**

原文这一节标题就叫 **AI Psychosis** 。原话是 agent 没让人少干活，身边几乎所有人都在比过去任何时候更拼命。

他把这套 loop 形容成反馈极快的视频游戏：你说一句，东西就长出来；改一句，结果又更好。原话： **"Building with agents is the greatest video game ever made."**

风险不是做出来的东西没人用，而是沉浸在 build 的兴奋里，把身边的人和真正重要的关系弄丢了。建议：休息，出门，和爱的人说话，做一点真的有人想要的东西——哪怕那个"人"只有你自己。

### **22｜这篇文章本身就是这么写出来的**

一个 Markdown 文件：

* Claude Code 跑在
```
cmux
```
里；
* 对着
```
Monologue
```
用语音说："把 no-IDE 的开头再进化一下""让 don't-read-the-plan 那一节更 spicy 一点""把 Tesla 和 Instacart 那个故事加进去"；
* agent 负责改写，他负责反应；
* last30days 提供最近材料；
* ```
Proof给别人 review。
```

最后补了一句：这次甚至没用 Zed，已经不用 IDE 了，也不敲代码。只剩下： **Talk, plan, build。**

地点不限：桌前、沙发上、车里、足球场边。

## 写在最后：看完这 22 条，先记住 5 件事

第一，Agentic Engineering 把
```
research → plan → build → review
```
变成了默认流水线。

**第二，拉开差距的往往是上下文。** 截图、issue、Slack 讨论、原始会议录音、过去十年的笔记，这些东西能稳定流进 agent，效果会完全不一样。

**第三，人的位置在上移。** 做的越来越像调度：给信号、给判断、给品味、给取舍。

**第四，agent 一旦拿到远程控制、邮箱入口、登录态和真实服务接口，就从代码助手变成执行层。**

**第五，越能 build，越要小心 build 带来的成瘾感。**

这 22 条拆成了可照着做的动作：该怎么开头、该开什么窗口、该把什么上下文喂进去、该在哪一步让人接管、以及什么时候该停下来。

**原文地址：https://x.com/mvanhorn/status/2061877533885473181**

![image](image_02.other)

**一起“**点****赞”** **三连** ↓**


原文链接: [https://mp.weixin.qq.com/s/Oo0iksfTXvUSFNnBrWOOpw?from=industrynews&color_scheme=light#rd](https://mp.weixin.qq.com/s/Oo0iksfTXvUSFNnBrWOOpw?from=industrynews&color_scheme=light#rd)