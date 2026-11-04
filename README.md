![FutureAide Control](assets/banner.svg)

# FutureAide Control

让 Codex 和 Claude Desktop 都能按名字调用 DSH 子代理，在当前项目中完成画图、写代码和文档等任务；调用方也可以把 Claude Desktop 或 Codex Desktop 当作被调用目标（实验性）。插件自动识别当前聊天和项目；每个调用方有自己的名单。

> **0.5.11（2026-11-04）**：派单结果和提问都能传回来了：助手没交最终报告时会被提醒一次，DSH 自带的提问工具会被拦下并转到 `ask_parent`。同时适配 DSH 0.2.2，单次读类工具调用从约 3.5 秒降到约 0.5 秒。主控用起来更省心：`futureaide_run_agent` 一次调用开工，工具默认只回决策需要的信息，`list` 一次看全整棵团队树，子代理的回报格式统一，监工的 CPU 和推送延迟都明显下降。Claude 调用 DSH 已实机验证。Codex Desktop 与 Claude Desktop 作为被调用目标（`target: 'codex-desktop'`、`'claude-desktop'`）仍是实验性的：功能在，后续继续完善，本版不按完成计。创建时选择 `target`，省略时仍使用 DSH，其后只按名字操作。

- **简单派活**：创建时只选名字和一次性/长期，直接发送任务文字。
- **直接交流**：助手用 `ask_parent` 提问，父级按名字回答；显式 `report_parent` 决定何时回包，正文只转发它提交的内容。
- **多层分工**：助手可安排原生下属，受管 Claude 与 Codex 也可用同一套工具跨应用分工；顶层最终交付等待整棵树收尾。
- **随时监工**：列表显示各层任务、活动、待答问题和文件归属，需要时再查差异或上下文。
- **管理生命周期**：一次性任务显式 final 报告送达且整树收尾后清除会话；长期代理保留上下文，按名字继续使用。

无需填写项目路径、内部 ID 或创建传信 txt。每次新派单、补充与回答接续跟随所选应用的当前默认模型和推理档位；同一输入的后台恢复保留原模型与请求身份。版本变化见 [CHANGELOG](CHANGELOG.md)。

## 调用 Claude Desktop，与调用 DSH 同一流程

当前机器已经接好正式入口。保持目标桌面应用运行，先用 `futureaide_status({})` 查看对应 `backends` 是否就绪，然后创建并派单：

```text
futureaide_create_agent({name: "方案搭档", lifetime: "persistent", target: "claude-desktop"})
futureaide_send_agent({name: "方案搭档", message: "阅读当前项目，检查方案并提出改进；需要确认就 ask_parent，完成后 report_parent(final:true)。"})
futureaide_list_agents({})
```

Claude 在自己的项目会话中工作；提问和显式报告回到创建它的聊天。父级用 `futureaide_answer_agent` 回答、`futureaide_agent_changes` 看文件、`futureaide_inspect_agent` 看上下文。Claude 需要 Codex 帮忙时，在自己的会话调用 `futureaide_create_agent({name, lifetime, target:"codex-desktop"})`，其余操作完全相同；省略 `target` 就调用 DSH。

`once` 在成功 final 送达且整树收尾后自动删除会话，保留项目产物；`persistent` 留下同一上下文供下一项任务使用。按名字取消保留上下文，按名字删除清理它拥有的整棵会话树。桌面调用的 `queued:true` 表示已持久保存，后续由监控推进，调用方无需重复发送。

## 安装

准备以下环境：

- Windows 上的 **Codex Desktop** 和已打开、可正常使用的 **DSH Desktop**。
- **Node.js 24.14 或更高版本**；使用下列克隆方式还需要 Git。
- 在 DSH 内配置模型账号和默认模型。当前一键安装接入其 `desktop` profile，会话清理适配 DSH **0.2.1-rc.3**。

在 PowerShell 中克隆仓库并安装。下面的 `D:\Tools\FutureAide-Control` 是示例，可以换成其他**非 C 盘的稳定目录**；安装器会拒绝 C 盘源目录。

```powershell
git clone https://github.com/XianYuLSya/FutureAide-Control.git D:\Tools\FutureAide-Control
Set-Location D:\Tools\FutureAide-Control
.\install.ps1
```

安装器准备依赖、注册并启用 Codex 插件、配置 DSH Host 桥接，同时把 FutureAide Control 注册为 Claude 的用户级插件，装完在 Claude 新开一个会话即可按名字使用。它保留其他 Codex/DSH 设置，并为改动文件保存备份。运行入口指向克隆目录，私有配置和状态位于其中的 `.runtime/`，请保留该目录的位置。

安装或升级后，在 Codex 的插件/MCP 设置中**重启或重新加载插件连接**；如果新增插件尚未出现，再重启 Codex Desktop。在项目聊天中让 Codex 调用：

```text
futureaide_status({})
```

确认工具已加载、聊天上下文已校验、DSH 已连接且 `treeProtocolReady: true`、`reportProtocolReady: true`、`ready: true`，即可派活。也可以直接说：“检查 FutureAide Control 是否就绪。” 如果工具尚未出现，先检查插件是否启用，再重启客户端。使用时保持 DSH Desktop 运行，模型与网络设置继续由 DSH 管理。

Claude 侧的桥接进程声明了 `tools.listChanged`：服务端的工具名或 schema 变化后（重连时或每 45 秒的比对中）会向已打开的会话发 `tools/list_changed`，不必为看到新工具而新开会话；比对本身失败只记日志，不影响工具调用。

使用自定义 DSH 数据目录时，安装可加 `-DshHome 'E:\DSH-data'`；重装会保留已保存的选择。升级可在原目录执行 `git pull`、重新运行 `install.ps1`，然后重新加载插件连接。

从 0.4 升级到 0.5 前，先让正在运行的任务完成。需要保留在途任务升级时，还须按原任务身份切换后台 `scoped-worker`；仅重新加载 MCP 不会替换已经启动的监工进程，也不要重新派发任务来代替迁移。

宿主目标由 `target` 决定：`dsh`（默认）、`claude-desktop`、`codex-desktop`。DSH 路径未指定实例时只读取 DSH 的注册记录，默认数据目录为 `DSH_HOME` 或 `~/.dsh`；桌面目标使用已由宿主打开的应用会话，每个目标单独发现与校验，不读取账号凭据、不启动独立 CLI 顶替桌面。旧 FutureAide 应用的 shell、端口、启动日志与环境变量覆盖一律不使用。手工维护配置中的 `target` 只能为 `dsh`，已有 `auto` / `futureaide` 配置会明确报错；安装器会生成固定 DSH 配置。`futureaide_*` 工具名和已有 DSH 状态字段保持兼容。

维护 CLI 默认使用此安装目录的 `.runtime/config.json`；`--config` 和配置环境变量可显式选择其他配置。桌面桥接若已绑定不同凭据或托管状态目录，安装会报告冲突并保留原绑定；只有确定要迁移时才使用 `desktop-host-install --rebind` 或 `connect-desktop.ps1 -Rebind`。

## 单代理：完成一次画图任务

直接对 Codex 说：“创建一次性画图助手，为当前项目生成中文架构图，保存为 `docs/architecture.svg`。” Codex 的工具调用如下，代码块是 MCP 调用示例，无需在终端执行：

```text
futureaide_run_agent({name: "画图助手", lifetime: "once", message: "阅读当前项目，生成中文架构图，保存为 docs/architecture.svg。"})
```

`run` 一次完成创建与派单，可以省略 `name` 让插件生成；名字已存在时直接把任务发给它。创建本身不会启动模型轮次，收到任务后才开始工作。切换供应商时，只需修改 DSH 默认模型；插件名单里的新旧代理在下一次输入派出时跟随该设置，无需逐条改配置或提供模型参数。正在执行的模型请求继续完成，失败任务不会自动重放，休眠代理不会为切换而全部唤醒；同一输入的后台恢复保留最初已确定的模型和请求身份。DSH 原生下属的新建与复用仍遵循其自身的模型继承和显式选择规则。

如果 DSH 询问图中需要包含哪些模块，问题会主动回到当前聊天，Codex 按名字回答即可：

```text
futureaide_answer_agent({name: "画图助手", message: "包含入口、主要模块、数据存储及它们的调用关系。"})
```

任务继续执行。DSH 助手在约定节点、需要 Codex 处理的事项或提交最终交付时，通过插件工具 `report_parent` 回传；日常进度留在任务记录。用 `final: true` 提交最终报告。普通回复、轮次结束和树空闲都不会唤醒 Codex。一次性助手的 final 报告确认送达且整树收尾后退出名单并清除会话数据，SVG 项目文件和已送达的回答保留。执行过程中可用 `futureaide_list_agents({})` 看进度，或用 `futureaide_agent_changes({name: "画图助手"})` 查看已观测到的修改。

已加载的旧 MCP 模块在插件/MCP 连接重新加载前仍走旧的前台路径；新的后台 worker 会优先使用绑定会话的定点等待/读取路径。

## 多代理：并行分工与长期复用

例如让一个长期助手画图，另一个一次性助手整理说明，分别写入不同文件：

```text
futureaide_create_agent({name: "架构图助手", lifetime: "persistent"})
futureaide_create_agent({name: "说明助手", lifetime: "once"})

futureaide_send_agent({name: "架构图助手", message: "阅读代码，将中文架构图写入 docs/architecture.svg，仅修改这个文件。"})
futureaide_send_agent({name: "说明助手", message: "阅读代码，将模块职责与调用关系写入 docs/architecture.md，仅修改这个文件。"})

futureaide_list_agents({})
futureaide_wait_agents({names: ["架构图助手", "说明助手"], timeout_seconds: 30})
```

两者分别提问和回包，Codex 统一协调。名单按聊天隔离，同名助手可以存在于不同聊天；代理使用项目的实际文件路径，并行任务应明确文件分工。

第一项任务结束后，可以继续使用长期助手的上下文：

```text
futureaide_send_agent({name: "架构图助手", message: "沿用刚才的架构图，增加图例并统一模块配色。"})
```

不再需要时，按名字清除长期助手及会话数据：

```text
futureaide_delete_agent({name: "架构图助手"})
```

## 让 DSH 团队长继续分配下属

Codex 只创建和联系团队长，由它通过 DSH 原生委派工具组织下属，下属也可以继续向下分工。例如：

```text
futureaide_create_agent({name: "设计团队长", lifetime: "persistent"})
futureaide_send_agent({name: "设计团队长", message: "组织下属分别分析架构和模块职责，明确文件分工；需要时继续分配下级，最后汇总结果。"})
futureaide_list_agents({})
futureaide_inspect_agent({name: "设计团队长"})
```

下属通过原生消息联系直接父级，需要 Codex 决定的问题由顶层提出；Codex 继续按顶层名字回答。插件不设固定层数上限，模型与工具权限仍由 DSH 管理。

## 工具与生命周期

| 工具 | 用途 |
|---|---|
| `futureaide_status` | 检查当前调用方与项目，以及三种后端各自是否就绪 |
| `futureaide_run_agent` | 一步创建并派单；名字已存在就直接发给它；省略 `name` 时自动生成 |
| `futureaide_create_agent` | 创建一次性或长期子代理；可选 `target`：`dsh`（默认）/`claude-desktop`/`codex-desktop` |
| `futureaide_send_agent` | 发任务、运行中补充（DSH 下模型下一步就能读到）；等待回答时也可直接答复 |
| `futureaide_answer_agent` | 回答当前待答问题 |
| `futureaide_list_agents` | 查看本聊天名单；有下属的名字用 `team` 一行一人列出整棵树 |
| `futureaide_wait_agents` | 按需等一个或多个名字，单次最多 45 秒 |
| `futureaide_agent_changes` | 看具体修改路径；每个路径一行，不带文件正文 |
| `futureaide_inspect_agent` | 深入查看上下文、工具及任务历史；`node` 只看一个成员 |
| `futureaide_cancel_agent` | 停止当前任务及所属后代，清除未执行输入，保留上下文 |
| `futureaide_delete_agent` | 关闭代理及所属后代，清除会话数据，保留项目产物 |

受管子代理侧另有两个工具：`ask_parent` 提问、`report_parent` 显式报告，由插件在目标会话内提供；普通输出、轮次结束与树空闲都不产生回包。DSH 助手的一轮结束却没有 final 报告时，插件会在同一任务里提醒它一次（主控侧不产生通知，任务保持 running）；失败或取消的轮次不提醒，提醒后仍没有 final 就正常停在 `awaiting_report`，同一任务不会重复提醒。Claude 与 Codex 目标的补充走各自持久队列，这次未加此提醒。两者的说明里带着同一份回报契约：`report_parent` 要求按 Result / Changes / Verified / Not verified / Decisions 分段、控制在 300 词内，团队长只汇总一份；`ask_parent` 要求写清要定的决定、选项与建议。Claude、Codex、DSH 三侧用的是同一段文本。

上级看全队只用一次 `futureaide_list_agents`：有下属的名字返回 `team`，后代每人一行（相对根、可寻址的 `path`、状态、运行时活动、文件数，文件数封顶时显示 `12+`），最多 30 行，超出以 `{more:n}` 收尾；两个成员同名时第二个起用 `名字#2`、`名字#3`。宿主读不到树时条目带 `treeError` 且没有 `team`——那是未知，不是“没有下属”。需要某个成员的对话时用 `futureaide_inspect_agent({name, node})`：`node` 取 `team` 里的路径（如 `"团队长/前端"`、`"subagent#2"`）或成员名，路径优先；被省略成 `…` 的路径按前缀匹配；同名命中多个成员时以 `node-ambiguous` 拒绝并给出可用路径，其余节点只留名字和状态。整份答案仍超长时先把每个 `team` 换成 `teamSize` 计数并加一条提示，再超才退化成 preview。

发送任务或补充消息返回精简受理回执；需要任务树、文件变更或历史时，按需使用列表、变更或查看工具。`queued: true` 表示已在本地保存（普通监工忙时进入持久队列），不得重发；`retrying: true` 表示原请求正等待后台恢复，调用方无需重发；`unknown` 表示原生写入结果不明，重试前先核对原回执和原收件人，绝不盲目重复；`accepted: true` 只表示目标宿主已受理，不代表任务完成或要求已落实。列表展示队列状态。

桌面目标的首次派发、忙时补充、取消与删除同样是**持久排队意图**：受理后不重发；执行者或监听器中断后按原 `requestId` 恢复原请求，已发出的不重放。

一个共享监控进程推进各名字的任务。任务树已静止且没有执行中或排队输入的等待代理显示 `monitor: sleeping`；发送或回答会唤醒它。监听器通常在宿主持久记录变化时唤醒，约每 30 秒补扫并处理待投递报告或问题。若所有插件连接及监听器均关闭，下次连接时恢复检查。Claude 子代理已结束而后台命令仍运行时，任务树继续显示运行中，取消也会停止该后台任务。

取消请求优先送到所属代理，即使普通监工操作正忙也不必等待其释放操作锁。返回 `accepted` 表示请求已被宿主接受；通过列表确认任务树停止，取消不会撤销已经发生的操作。若自动清理已经开始，取消返回未接受。

列表保持简短，文件全文只在请求详细变更时返回。五个读工具（`futureaide_status`、`futureaide_list_agents`、`futureaide_wait_agents`、`futureaide_agent_changes`、`futureaide_inspect_agent`）与 `futureaide_create_agent` 默认返回精简结构：列表条目只有名字、状态、生命周期、任务、待答问题、最新报告（含未送达数量）、改动文件计数（含精确的 unconfirmed 数量）、团队名单与停止的监控，覆盖率、时间戳、每个成员的改动清单和完整结果文字都不占上下文；`changes` 每条路径只留路径、操作，根以下的 `agentPath` 与 `unconfirmed` 归属才保留，文件正文只在 `detail: true` 时返回。文件观察优先采用本代理原生文件工具的成功结果。shell 写入靠任务前后的 `git status` 比对发现，这类条目标为 `attribution: unconfirmed`：同一时间别的进程或助手的改动也会出现，gitignore 覆盖的路径和非 git 目录看不到。仍可能只有部分覆盖，工具会明确说明，不把共享项目的全部改动归给某个代理。

DSH 助手可以继续调用其原生子代理，形成多层任务树；Codex 仍只按顶层名字操作。列表和变更会显示下属层级、活动以及文件的 `agentPath` 归属，`inspect_agent` 可深入查看该树的对话。顶层一轮结束不等于整项任务完成：只有顶层助手显式提交 final 报告，插件才在子孙执行与原生通知全部收齐后转发其正文，并为一次性助手清理整棵受管树。下属向其 DSH 父级汇总，不直接报告 Codex。取消或删除顶层名字也作用于它的下属树，不影响其他聊天的代理。

普通 Codex 聊天支持后台回包；当前桌面对原生 multi-agent v2 子代理调用者拒绝后台回包。遇到该明确拒绝时，插件显示 `native-callback-unavailable`、保留未送达报告和原收件人，并停止重复投递。

**一次性**完成一项任务，过程中可以多次提问、回答和显式报告。非 final 报告不会结束任务。成功的 final 报告确认送达且整树收尾后，插件关闭实例、删除该会话数据及私有记录，再移出名单。取消或失败只更新可见状态，不自动发送通知或清理；已提交的报告仍继续交付，代理可由用户按名字删除。清理失败仍显示在列表。已回到 Codex 的结果与项目产物保留。

**长期**显式 final 报告完成交付后回到空闲，留在名单中，下一项任务使用原上下文。没有 final 时显示 `awaiting_report`，同名发送继续原任务；final 已提交但尚未交付时不接受追加消息；派下一单时会先读回确认，回报已经进入对话就直接开始。只有按名字删除时才清除会话数据；停止当前任务不等于删除代理。取消或失败后，没有待投报告的长期代理可在同一会话开始新任务；一次性代理需显式删除。用户主动删除会同时丢弃尚未交付的报告。

模型请求失败时，列表和查看结果中的 `error.source: "model"` 给出稳定错误代码、可用的 HTTP 状态和简短提示。例如 `no_healthy_account` 表示所用模型网关当前没有健康账号。模型失败原因保存在原任务中，不触发自动回包；新任务或后续成功会清除当前展示中的旧失败。升级前已失败的代理可通过一次正常查看补齐原因。

`wait_agents` 遇到已自动退出的名字会返回 `notListed`，完成情况以已收到的结果为准。多代理组织由 Codex 负责，受管 DSH 助手使用各自的任务会话。

## 连接与结果

插件使用本机 MCP 与目标应用的桌面接入。任务回执、问题、答案及待回包结果持久保存；连接恢复后按原任务继续，不新建代理顶替。发送情况不明时先核对原生证据，回包情况不明时核对原聊天，不盲目发送第二份。

`delivery_pending` 表示工作已完成、结果正在等待交付；此时一次性会话尚未删除。已持久保存且具备交付条件的显式报告可在 DSH 暂时离线时继续交付。旧版本自动生成的结果缓存不会被转换成报告或触发自动清理。插件工具被客户端卸载或尚未加载时，需要重新启用或重新加载插件连接；未恢复时再重启 Codex。

### 某些聊天提示 `Transport closed`

每个聊天都有自己的调用连接和代理名单。一个聊天能用，不代表其他聊天的连接正常；插件没有“只允许一个聊天使用”的限制。若工具直接返回 `Transport closed`，尤其 Codex 内置工具也同样失败，应恢复 Codex 持有的连接。重新派发 DSH 任务或只重启 DSH 不能代替这一步。

克隆目录提供独立的 [recover.cmd](recover.cmd)：在**文件资源管理器**中双击，输入 `R`，即可完整退出 Codex 及其后台进程并重新打开。它保留原启动路径和参数，包括代理参数；不删除聊天、代理记录或项目文件，不重启 DSH。此操作会中断 Codex 正在执行的聊天，并可能暂时停止回包 worker，请在合适的时候执行。不要在 Codex 自己的终端或工具中运行重启操作。

只检查目标进程时，在克隆目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\recover-codex.ps1 -Check
```

这项检查不重启应用，也不代表聊天连接已恢复。重新打开后，**在每个受影响的原聊天**调用 `futureaide_status({})` 和 `futureaide_list_agents({})`，核对原名单，再继续原任务。恢复入口不依赖已断开的 MCP 通道；目前不自动重启整个 Codex，也未将此入口宣称为客户端断连根因的修复。

本次多聊天断连已通过逐进程审计确认来自外部定时清理器：它将暂时无 CPU/I/O 活动的后台 MCP 误判为残留并终止。MCP 没有窗口、等待请求时不活动，都不表示连接已无用。若运行类似进程清理工具，应保留存活 Codex 进程树内的工具，仅清理能确认失去所属关系的残留；停止误杀后，还需在 Codex 设置重载已关闭的 MCP 连接。该外部清理器不属于本插件，其他 Transport closed 仍应依据各自日志判断。

后台 worker 异步启动失败的修补是另一个独立缺陷。安装配置下，新启动的 MCP 进程会在 `.runtime/diagnostics/` 记录精简生命周期日志，包含进程、工具名和聊天身份，不包含任务正文、结果或凭据。

**安装范围**：`install.ps1` 现在准备三样东西：Codex 插件、本机 DSH 主机桥接，以及 Claude 的**用户级插件**。安装器在 `.runtime/claude-marketplace` 生成一个只含清单、MCP 配置和 skill 的薄插件（运行目录仍以绝对路径指向 D 盘），随后依次执行 `claude plugin marketplace add … --scope user` 与 `claude plugin install futureaide-control@futureaide --scope user`。注册是用户级的，Claude 在**任何项目**发起的会话都能按名字调用 DSH 子代理，不必为每个项目单独写 `.mcp.json`。Claude 只在新开会话时加载插件，安装前已打开的会话不会自动生效，需要新开一个。找不到 `claude` 命令或注册失败都不影响 Codex 安装，返回值里 `claude.registered` 会是 `false` 并带原因；桌面端自带的 `claude.exe` 不在 PATH 时可用 `-ClaudeCli <path>` 指定，不想改 Claude 环境时用 `-SkipClaude`。插件从 D 盘原地加载，重新运行安装器重新生成文件即完成升级。Codex Desktop 注册尚未纳入一键安装。本机已完成三目标正式接入：Codex 的 `futureaide` 与 Claude 的 `futureaide-report` 都指向同一正式目录和状态库，旧开发注册已退役。日常调用不需要重新运行安装器。

## 本版验证结论（2026-11-04）

- **Claude → DSH 全链路已实机通过**：派单、问答、并行、多层树、上下文复用、取消、删除、会话重启后回报、忙时补充、shell 写入的 `changes`。
- **互调目标未重新验证**：Codex 与 Claude 互调的目标（`target: 'codex-desktop'`、`'claude-desktop'`）在本版改动后尚未重新验证，仍按实验性处理。

## 已知未完成

- Claude 会话的创建、选模、停止、删除仍靠界面自动化。
- Codex 子会话目前走 `create_thread`，会被当作委派，权限降级并可能弹出审批。
- Claude → Codex → DSH 混合树的删除尚未重测。
- 退出整个应用再打开后的恢复未验证。

## 维护与兼容

名字式工具依赖已接入的 Codex 或 Claude Desktop 会话上下文和回传通道。其他 MCP 客户端，以及仅有 DSH web/tui profile 的环境，需要相应适配。

原生会话清理支持上述 DSH 版本的 JSONL 会话、项目索引和派生缓存；不支持的存储后端会返回清理失败。整树清理支持本机原生 one-shot / continuable 下属；外部托管的下属会明确报告不支持自动清理。文件观测会注明覆盖范围；当前派单接口使用文字，图片附件尚不是一等输入参数。

显式 ID 的 CLI 仍可用于 DSH 维护，查看 `node src/cli.mjs --help`。需要该 MCP 管理面时，在维护环境设置 `FUTUREAIDE_LEGACY_TOOLS=1`；它与默认名字工具面择一启用。这里的 legacy 指维护接口，不表示仍支持旧 FutureAide 宿主。详细用法见 [旧版 CLI 与显式接口](skills/futureaide-control/references/legacy-workflows.md)。DSH 版本使用的 slash / dot HTTP API 适配均保留，status 中的 `apiDialect: legacy` 只表示 slash 协议。

QQ 交流群：259109974。
