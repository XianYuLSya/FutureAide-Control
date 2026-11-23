![FutureAide Control](assets/banner.svg)

# FutureAide Control

在 Codex 或 Claude Desktop 的聊天里，按名字把活派给 DSH、Codex 或 Claude。

你只要说“让画图助手做这件事”。助手在自己的会话里干活，有问题回来问你，做完把报告交回这个聊天。不用填项目路径和内部 ID，也不用建传信文件。

[快速开始](#快速开始) · [派给谁](#派给谁) · [常见用法](#常见用法) · [工具一览](#工具一览) · [遇到问题](#遇到问题) · [详细说明](REFERENCE.md) · [更新记录](CHANGELOG.md)

QQ 交流群：259109974

## 能做什么

- **按名字派活**：一句话创建并派单。名字跟着当前聊天走，别的聊天里的同名助手互不相干。
- **派单时选模型**：名字可以固定模型；`effort` 可单传，每个新轮次按当前模型选默认档。
- **直接问答**：助手用 `ask_parent` 提问，你按名字回答，原任务接着跑。
- **只收明确的回报**：助手用 `report_parent` 交的内容才会回到聊天，普通回复不打扰你。
- **多层分工**：助手可以再派下属。最终报告要等整棵任务树收尾才交。
- **随时查看**：列表里看进度、待答问题和文件改动，需要时再看完整对话。
- **两种生命周期**：一次性助手交付后自动清理，长期助手保留上下文接着用。

## 派给谁

创建名字时用 `target` 选一次，之后只按名字操作。

| 目标 | `target` | 怎么运行 | 前提 |
|---|---|---|---|
| DSH | 省略，或 `dsh` | 在 DSH 里运行，模型和网络由 DSH 管理 | DSH Desktop 开着 |
| Codex Desktop | `codex-desktop` | 在 Codex 自己的会话里运行 | Codex 由 FAswitch 打开 |
| Claude CLI | `claude-cli` | 后台运行 `claude -p`，不用开窗口，也不用开着对话 | Claude CLI 已登录 |

目标不可用时会明确报错，不会悄悄换成别的目标。

## 快速开始

需要：

- Windows 上的 Codex Desktop
- 已打开、配置好模型账号的 DSH Desktop（当前接入它的 `desktop` profile，会话清理适配 DSH 0.2.1-rc.3）
- Node.js 24.14 或更高版本、Git
- 要从 Claude 派活，或用 `claude-cli` 目标时，再装 Claude Desktop

在 PowerShell 里克隆并安装。目录可以换，但要放在**非 C 盘的固定位置**，安装器会拒绝 C 盘：

```powershell
git clone https://github.com/XianYuLSya/FutureAide-Control.git D:\Tools\FutureAide-Control
Set-Location D:\Tools\FutureAide-Control
.\install.ps1
```

安装器会准备依赖，注册 Codex 插件和 Claude 用户级插件，并配置 DSH 桥接。其他设置不动，改过的文件会留备份。

装完在 Codex 的插件设置里重新加载插件连接，Claude 新开一个会话。然后在聊天里说：

> 检查 FutureAide Control 是否就绪。

它会调用 `futureaide_status({})`。`ready: true` 就可以派活了，这里也能看到每个目标的就绪状态和可选模型。

升级：在原目录 `git pull`，重新运行 `install.ps1`，再重新加载插件连接。升级前先让运行中的任务做完，详见[遇到问题](#遇到问题)。

## 常见用法

下面的代码块是聊天里的工具调用，不用在终端执行。你也可以直接用自然语言说，比如“创建一次性画图助手，生成架构图保存到 `docs/architecture.svg`”。

### 派一个一次性任务

```text
futureaide_run_agent({name: "画图助手", lifetime: "once", message: "阅读当前项目，生成中文架构图，保存为 docs/architecture.svg。"})
```

助手有问题时会问回来，你按名字回答，任务继续：

```text
futureaide_answer_agent({name: "画图助手", message: "包含入口、主要模块、数据存储及调用关系。"})
```

它用 `report_parent(final: true)` 交付后自动退出名单，会话数据清掉，项目文件和已送达的结果保留。

### 选模型和强度

```text
futureaide_run_agent({name: "审阅搭档", target: "codex-desktop", model: "astra", effort: "high", message: "检查当前修改并报告发现。"})
```

`model` 可以写完整 ID，也可以写其中一段，回执里的 `actualModel` 是最终解析出的模型。写错会报错并列出可选项，不会退回默认。省略 `model` 时，在当前会话模型或目标默认模型上选档。

```text
futureaide_create_agent({name: "校对", lifetime: "persistent", effort: "medium"})
futureaide_send_agent({name: "校对", message: "校对这份说明"})
```

首次 send 使用 create 指定的 medium。后续新轮省略 effort 时，插件按完整模型 ID 查 `modelDefaultEfforts`，未命中则取 `defaultEffort`。出厂配置如下。

```json
{ "defaultEffort": "max", "modelDefaultEfforts": { "gpt-6.2-astra": "high" } }
```

在当前安装使用的 `config.json` 修改这两项；命名 profile 可覆盖全局值和单个模型。重载插件连接和监工后，新收件按新配置选档，已收件保留快照。模型缺档时取最接近的支持档，同距取低。例如请求 max 而模型最高支持 high，`requestedEffort` 为 max、`selectedEffort` 为 high，`effortAdjustment` 给出原因，确认执行后 `actualEffort` 为 high。排队尚未执行时实际档为空。Codex 插话沿用当前轮的档位。`dshDefaultModelOnly` 开启时只锁 DSH 默认模型，仍可单传 effort。

### 并行分工

```text
futureaide_create_agent({name: "架构图助手", lifetime: "persistent"})
futureaide_create_agent({name: "说明助手", lifetime: "once"})

futureaide_send_agent({name: "架构图助手", message: "将中文架构图写入 docs/architecture.svg，仅修改这个文件。"})
futureaide_send_agent({name: "说明助手", message: "将模块职责写入 docs/architecture.md，仅修改这个文件。"})

futureaide_list_agents({})
```

几个助手共用一个项目时，派单里写清各自负责的文件。

### 接着用长期助手

```text
futureaide_send_agent({name: "架构图助手", message: "沿用刚才的架构图，增加图例并统一配色。"})
futureaide_delete_agent({name: "架构图助手"})
```

长期助手保留上下文，不再需要时按名字删除。

### 忙时插话与排队

助手正在干活时，`futureaide_send_agent` 和同名 `futureaide_run_agent` 可以带 `mode`：

| `mode` | 效果 |
|---|---|
| 省略 | 跟随目标原有习惯：Codex / DSH 有活动轮时插进当前轮，下一步读到；Claude CLI 留到当前轮结束后的同一会话下一轮 |
| `steer` | 明确插进当前轮，活动轮下一次模型动作读到；没有活动轮时直接开新一轮 |
| `queue` | 明确排在当前轮之后：当前轮自然结束后，单独作为下一轮的第一条输入，不并入当前轮 |

目标做不到的组合会直接拒绝，返回 `error.code: "mode-unsupported"`、`error.target`、`error.supportedModes`，同时 `accepted: false`；不入队、不调后端、不改模型：

| 目标 | 忙时省略 | 显式 `steer` | 显式 `queue` |
|---|---|---|---|
| Codex Desktop | 插入当前轮 | 插入当前轮 | 等当前轮结束后开新轮 |
| DSH | 下一步读到 | 下一步读到 | 拒绝，`supportedModes: ["steer"]` |
| Claude CLI | 排到轮间，下一轮开始 | 拒绝，`supportedModes: ["queue"]` | 排到轮间，下一轮开始 |

没有活动轮时，两种模式都直接开新一轮。有待答问题时，省略 mode 或显式 `steer` 的普通 send 作为回答；显式 `queue` 只排补充，不代答。DSH 忙时显式 `queue` 一律拒绝，即使有待答问题。

补充回执会带 `requestId`、`mode`、`delivery`，有原生证据时带 `turnId`，已知所排轮次时带 `afterTurnId`：

| `delivery` | 意思 |
|---|---|
| `local-pending` | 只在本地存下，尚未核实根轮；`accepted: false, queued: true` |
| `after-current` | 已登记在活动轮 A 之后；`afterTurnId: A`，`accepted: false, queued: true` |
| `current-turn` | 输入已进入活动轮。Codex 的回执给出 `turnId: A`。 |
| `new-turn` | 输入已开启新轮。Codex 的回执给出 `turnId: B`。 |
| `answer-pending` / `answered` | 已作为回答登记 / 回答已实际送达 |
| `accepted-route-unknown` | 原生记录可证已写入，但去向无法确认；`accepted: true, queued: false` |
| `unknown` / `blocked` | 写入结果未知，不自动重发 / 明确拒绝、取消或过期，附真实原因 |

DSH 由宿主在写入时确认去向。若补充写入前活动轮已结束，新轮按收件时冻结的档位执行，回执显示 `new-turn` 和确认的 `actualEffort`。按 `requestId` 可在 `futureaide_inspect_agent({name})` 的 `inputs` 查到对应输入。`list` 的 `inputDelivery` 显示最近一次已确认的输入去向，`delivery` 显示报告送达状态。

### 派给后台的 Claude

先登录一次 CLI。在安装目录运行下面两条，找到 Claude Desktop 自带的 CLI 并登录它自己的账号：

```powershell
$claudeCli = node --input-type=module -e "import {findClaudeCli} from './scripts/install-plugin.mjs'; console.log(await findClaudeCli())"
& $claudeCli auth login
```

`futureaide_status({})` 里 `backends["claude-cli"].ready` 为 `true` 后就能派：

```text
futureaide_run_agent({name: "审稿", target: "claude-cli", lifetime: "persistent", message: "检查当前项目的改动，完成后用 report_parent 提交最终报告。"})
futureaide_send_agent({name: "审稿", message: "接着检查刚才提到的第二处。"})
```

同一个名字接着原会话。权限用官方的 `auto` 模式，需要人工批准的操作会被拒绝，可以在 `inspect` 里看到。删除名字不会删除 Claude 自己保存的会话历史。网络走 FAswitch 写进 Claude 用户设置的当前档案代理。

## 工具一览

| 工具 | 用途 |
|---|---|
| `futureaide_status` | 看当前聊天、项目、各目标的就绪状态和可选模型 |
| `futureaide_run_agent` | 一步创建并派单，名字已存在时直接派给它；`mode` 可选插话或排队 |
| `futureaide_create_agent` | 预留名字，可选 `target`、`model`、`effort` |
| `futureaide_send_agent` | 派单或补充，也可以更新模型和强度；`mode` 可选插话或排队 |
| `futureaide_answer_agent` | 回答助手的问题 |
| `futureaide_list_agents` | 看本聊天的名单，有下属时一人一行列出整棵树 |
| `futureaide_wait_agents` | 派单后用回执中的 taskKey 等一次，省略 timeout_seconds，直到有报告、提问或终态。收到阶段报告后如需等下一件事，把 nextCursor 原样作为 after。显式 0 为快照，1–45 为有界查询。 |

本机 Codex 的单次工具预算为 60 秒，进度通知不能续期。Claude Code 交互主会话默认约两分钟把长调用转到后台；子代理及非交互模式的行为不同。连接断开或宿主超时后，原任务仍会回报，请保留原派单回执。无需循环等待或重派。
| `futureaide_agent_changes` | 看改了哪些文件 |
| `futureaide_inspect_agent` | 看对话、工具调用和任务历史 |
| `futureaide_cancel_agent` | 停止当前任务和下属，保留上下文 |
| `futureaide_delete_agent` | 关闭助手和下属，清除会话数据，保留项目文件 |

助手这边另有两个工具：`ask_parent` 提问，`report_parent` 回报。

**一次性（`once`）**在 `final` 报告送达且整棵树收尾后自动清理。树里还有已受理的提问或报告待投递时，清理会等待。如果某条投递进入 `blocked`，名册会保留它的正文。**长期（`persistent`）**交付后回到空闲，下一项任务沿用同一个上下文。上一轮还有已受理的提问或报告未到投递终态时，同名派单会返回待处理条数，待投递送达或进入 `blocked` 后可重试。

**回执怎么看：**

| 回执 | 意思 | 该做什么 |
|---|---|---|
| `queued: true` | 已保存，等后台推进 | 不要重发 |
| `retrying: true` | 原请求在后台恢复 | 不要重发 |
| `accepted: true` | 目标已受理，不代表做完 | 等报告 |
| `unknown` | 写入结果不明 | 先查原任务，不要盲目重发 |

### 子代理自动清理

管理员可以先预览到期代理、DSH 会话和残留文件，再签认首批处置及需要保留的对象。总开关默认关闭，未送达的正文在删除前永久另存。见[自动清理的配置、清单和恢复命令](docs/agent-auto-cleanup.md)。

### Codex 闲置会话回收

受管 Codex 助手一轮结束，回报、问答、补充与任务树都收尾后，FutureAide 会请 Codex 释放它创建的线程。收到退订回执后，监工等 Codex 确认线程已经卸载。同名再派活会恢复原线程，并沿用已选的模型和推理强度。

监工会检查主窗口与分离页面。页面显示该线程、仍持有它的流，或状态无法核实时，回收会暂缓。已确认没有显示会话的隐藏空壳允许回收。一次性助手仍按自身的自动删除规则收尾。

FutureAide 的 `config.json` 中，`idleSessionCleanup` 默认是 `true`，控制退订、stdin 关闭后的退出、冷线程读取和监工判活与拉起。设为 `false` 时，这些路径恢复原有行为。取消轮次拒收新的提问和报告，已接收的收件在换轮前处理，两项规则始终生效。

### Claude 回报待收提醒

原 Claude Desktop 会话持续不在运行时，监工会发一条 Windows 通知，附助手名、回报摘要及查看全文的方法。等待时间由 `config.json` 的 `claudeCallbackReminderMs` 配置，默认 `600000` 毫秒。重新打开原会话后，插件会继续尝试投递原回报。

### 团队小看板

`config.json` 的 `teamBoard` 默认是 `false`。开启后，在监工本地报告端口访问 `http://127.0.0.1:<端口>/board`。页面打开时才请求花名册数据。

## 遇到问题

| 现象 | 处理 |
|---|---|
| 工具没出现 | 确认插件已启用，重新加载插件连接，再不行重启客户端 |
| `claude-cli` 显示未就绪 | 看 `reason`。多半是 CLI 没登录，按上面的步骤登录 |
| 升级后 `claude-cli` 任务一直运行中，没有动静 | 旧监工还在跑旧代码。结束 `scoped-worker.mjs` 这个 node 进程，下次调用工具时会用新版起来，期间工具会断一小会儿 |
| `codex-native-rpc-unavailable` | Codex 不是由 FAswitch 打开的，从 FAswitch 重新打开 |
| `no_healthy_account` | 模型网关没有可用账号，到 DSH 检查账号 |
| `delivery_pending` | 工作已完成，结果等待交付，不用重发 |
| 提示 `Transport closed` | 这个聊天的连接断了。在**文件资源管理器**里双击 [recover.cmd](recover.cmd)，输入 `R`。这会重启 Codex 并中断正在跑的聊天，不会删聊天和项目文件 |

更多细节见[详细说明](REFERENCE.md)。

## 当前状态

**已实机验证：**

- Claude 调 DSH：派单、问答、并行、多层树、上下文复用、取消、删除
- Claude 调 Codex，Codex 再调 DSH
- Codex 和 Claude 调 Claude CLI：派单、回报

**还没验证：**

- Codex 调 DSH 混合树的删除
- 退出整个应用后再打开的恢复
- Claude CLI 各模型和强度的组合，以及登录、刷新令牌这两段的网络出口

**已知限制：**

- 目前只支持 Windows。
- 派单只接受文字，图片不是正式输入。
- 取消 Codex 助手时，它已经启动的 shell 命令不会被结束。
- 其他 MCP 客户端，以及只有 DSH web 或 tui profile 的环境，需要自己适配。

## 许可证

[MIT](LICENSE)。第三方代码的许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
