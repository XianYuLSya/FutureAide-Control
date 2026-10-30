![FutureAide Control — DSH Control](assets/banner.svg)

# FutureAide Control · DSH Control

让 Codex 按名字调用 DSH 子代理，在当前项目中完成画图、写代码和文档等任务。每个 Codex 聊天有自己的代理名单，插件自动绑定项目路径、会话身份和回包目标。

- **简单派活**：创建时只选名字和一次性/长期，直接发送任务文字。
- **直接交流**：DSH 的问题回到原聊天，Codex 按名字回答；完成后自动返回结果和文件变更摘要。
- **随时监工**：列表显示任务、活动、待答问题和修改路径，需要时再查差异或上下文。
- **管理生命周期**：一次性任务回包后自动清除会话；长期代理保留上下文，按名字继续使用。

0.3 的默认入口是 Codex Desktop 插件，无需填写内部 ID 或创建传信 txt。版本变化见 [CHANGELOG](CHANGELOG.md)。

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

安装器准备依赖、注册并启用 Codex 插件、配置 DSH Host 桥接。它保留其他 Codex/DSH 设置，并为改动文件保存备份。运行入口指向克隆目录，私有配置和状态位于其中的 `.runtime/`，请保留该目录的位置。

安装完成后**重启 Codex Desktop**，在项目聊天中让 Codex 调用：

```text
futureaide_status({})
```

确认工具已加载、聊天上下文已校验、DSH 已连接且 `ready: true`，即可派活。也可以直接说：“检查 FutureAide Control 是否就绪。” 如果工具尚未出现，先检查插件是否启用，再重启客户端。使用时保持 DSH Desktop 运行，模型与网络设置继续由 DSH 管理。

使用自定义 DSH 数据目录时，安装可加 `-DshHome 'E:\DSH-data'`；重装会保留已保存的选择。升级可在原目录执行 `git pull`、重新运行 `install.ps1`，然后重启 Codex。

## 单代理：完成一次画图任务

直接对 Codex 说：“创建一次性画图助手，为当前项目生成中文架构图，保存为 `docs/architecture.svg`。” Codex 的工具调用如下，代码块是 MCP 调用示例，无需在终端执行：

```text
futureaide_create_agent({name: "画图助手", lifetime: "once"})
futureaide_send_agent({name: "画图助手", message: "阅读当前项目，生成中文架构图，保存为 docs/architecture.svg。"})
```

创建不会启动模型轮次，收到任务后才开始工作。如果 DSH 询问图中需要包含哪些模块，问题会主动回到当前聊天，Codex 按名字回答即可：

```text
futureaide_answer_agent({name: "画图助手", message: "包含入口、主要模块、数据存储及它们的调用关系。"})
```

任务继续执行，最终回答和交付路径自动返回。一次性助手确认回包后退出名单并清除会话数据，SVG 项目文件和已送达的回答保留。执行过程中可用 `futureaide_list_agents({})` 看进度，或用 `futureaide_agent_changes({name: "画图助手"})` 查看已观测到的修改。

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

## 工具与生命周期

| 工具 | 用途 |
|---|---|
| `futureaide_status` | 检查当前聊天绑定与 DSH 桥接 |
| `futureaide_create_agent` | 创建一次性或长期子代理 |
| `futureaide_send_agent` | 发任务、运行中补充；等待回答时也可直接答复 |
| `futureaide_answer_agent` | 回答当前待答问题 |
| `futureaide_list_agents` | 查看本聊天名单、任务、活动、问题和修改摘要 |
| `futureaide_wait_agents` | 按需等一个或多个名字，单次最多 45 秒 |
| `futureaide_agent_changes` | 看具体修改路径和可得的内容差异 |
| `futureaide_inspect_agent` | 深入查看上下文、工具及任务历史 |
| `futureaide_cancel_agent` | 停止当前任务并清除未执行输入 |
| `futureaide_delete_agent` | 关闭代理并清除其会话数据 |

列表保持简短，文件全文只在请求详细变更时返回。文件观察优先采用本代理原生文件工具的成功结果；shell 或外部程序写入仍可能只有部分覆盖，工具会明确说明，不把共享项目的全部改动归给某个代理。

**一次性**完成一项任务，过程中可以多次提问和回答。最终成功、失败或取消结果确认送达后，插件关闭实例、删除该会话数据及私有记录，再移出名单。清理失败仍显示在列表。已回到 Codex 的结果与项目产物保留。

**长期**完成后回到空闲，留在名单中，下一项任务使用原上下文。只有按名字删除时才清除会话数据；停止当前任务不等于删除代理。

`wait_agents` 遇到已自动退出的名字会返回 `notListed`，完成情况以已收到的结果为准。多代理组织由 Codex 负责，受管 DSH 助手使用各自的任务会话。

## 连接与结果

插件使用本机 MCP 与 DSH 桥接。任务回执、问题、答案及待回包结果持久保存；连接恢复后按原任务继续，不新建代理顶替。发送情况不明时先核对原生证据，回包情况不明时核对原聊天，不盲目发送第二份。

`delivery_pending` 表示工作已完成、结果正在等待交付；此时一次性会话尚未删除。DSH 已完成的缓存结果可以在 DSH 暂时离线时继续回传。插件工具被客户端卸载或尚未加载时，需要重新启用插件并重启 Codex。

### 某些聊天提示 `Transport closed`

每个聊天都有自己的调用连接和代理名单。一个聊天能用，不代表其他聊天的连接正常；插件没有“只允许一个聊天使用”的限制。若工具直接返回 `Transport closed`，尤其 Codex 内置工具也同样失败，应恢复 Codex 持有的连接。重新派发 DSH 任务或只重启 DSH 不能代替这一步。

克隆目录提供独立的 [recover.cmd](recover.cmd)：在**文件资源管理器**中双击，输入 `R`，即可完整退出 Codex 及其后台进程并重新打开。它保留原启动路径和参数，包括代理参数；不删除聊天、代理记录或项目文件，不重启 DSH。此操作会中断 Codex 正在执行的聊天，并可能暂时停止回包 worker，请在合适的时候执行。不要在 Codex 自己的终端或工具中运行重启操作。

只检查目标进程时，在克隆目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\recover-codex.ps1 -Check
```

这项检查不重启应用，也不代表聊天连接已恢复。重新打开后，**在每个受影响的原聊天**调用 `futureaide_status({})` 和 `futureaide_list_agents({})`，核对原名单，再继续原任务。恢复入口不依赖已断开的 MCP 通道；目前不自动重启整个 Codex，也未将此入口宣称为客户端断连根因的修复。

已修复后台 worker 启动失败可能使 MCP 进程退出的一处缺陷。原始多聊天断连仍在排查，不能认为该缺陷已解释全部现场症状。安装配置下，新启动的 MCP 进程会在 `.runtime/diagnostics/` 记录精简生命周期日志，包含进程、工具名和聊天身份，不包含任务正文、结果或凭据。

## 维护与兼容

默认名字式工具依赖本机 Codex Desktop 的可信聊天上下文和回传通道。其他 MCP 客户端，以及仅有 DSH web/tui profile 的环境，需要相应适配；它们不具备这里描述的默认接入体验。

原生会话清理支持上述 DSH 版本的 JSONL 会话、项目索引和派生缓存；不支持的存储后端会返回清理失败。文件观测会注明覆盖范围；当前派单接口使用文字，图片附件尚不是一等输入参数。

旧 CLI 仍可用于维护，查看 `node src/cli.mjs --help`。需要旧 MCP 管理面时，在维护环境设置 `FUTUREAIDE_LEGACY_TOOLS=1`；它与默认名字工具面择一启用。详细用法见 [旧版 CLI 与显式接口](skills/futureaide-control/references/legacy-workflows.md)，其中手工指定 ID 等流程属于旧接口。

QQ 交流群：259109974。
