# FutureAide Control 详细说明

这里放 [README](README.md) 里没展开的细节。日常使用看 README 就够了。

## 模型选择

`model` 忽略大小写，先找完全相同的 ID，再选包含该片段的第一项。回执、`list` 和 `wait` 的 `actualModel` 显示解析出的完整 ID。找不到时，错误会列出可选 ID。

`effort` 必须是所选模型支持的档位。每次显式指定 `model` 时省略它，会采用该模型的默认档位。已选模型的名字可以单传 `effort` 调整档位。后续任务、补充、回答和提醒都沿用这个名字的选择。

从未指定模型的名字，在下一次输入派出时读取目标应用的默认模型。正在执行的模型请求继续完成，失败任务不会自动重放。同一输入的后台恢复保留最初确定的模型和请求身份。DSH 原生下属的新建与复用仍按它自己的继承和显式选择规则。

DSH 通过本版宿主桥把显式选择应用到该会话。工具提示更新宿主桥时，用本版安装流程同步 DSH 端后再派单。

## Codex Desktop 目标

调试端口是 FAswitch 启动时加的，Codex 自身不开，所以 Codex 要由 FAswitch 打开。

插件经主渲染进程的本地调试端口发 `thread/start`、`turn/start`，和界面新建对话走同一个入口。后续发送、补充、打断、删除和观察也走这条 app-server RPC。插件不读 Codex 的数据库、thread history 或 rollout 文件，不读账号凭据，也不启动独立 CLI 或第二个 app-server。

- 已选模型的名字在 `turn/start` 传入完整模型和推理档位，其余名字由 Codex 决定。
- `turn/steer` 只补充当前轮次。运行中换模型或档位会报错，等该轮结束后再发送。
- 权限沿用 Codex 设置。
- 标题等会话有内容后再用 `thread/name/set` 补上，失败最多重试 5 次，不影响任务。
- 没有调试端口时，`status` 的 `codex-desktop` 项报 `codex-native-rpc-unavailable`。这时普通 Codex 对话调用 DSH 不受影响。
- 取消会停下模型这一轮，但 Codex 已经启动的 shell 命令不会被结束。

## Claude CLI 目标

插件运行 `claude -p`，用 `--session-id` 开始会话，用 `--resume` 接续。进程可以脱离调用方的 MCP 连接继续执行。

- **登录：** 只用 CLI 自己的登录，用 `claude auth status` 判断是否就绪。插件不读凭据文件，也不提取 Claude Desktop 的登录缓存。
- **代理：** 插件不设置、不清除任何代理变量。FAswitch 把当前档案的代理写进 Claude 用户设置，CLI 自己加载。
- **权限：** 固定用 `--permission-mode auto --permission-prompts none`。这两个参数不可用时报错，不会自动放宽。
- **模型：** 省略 `model` 时由 CLI 选默认模型，`list`、`wait` 在 CLI 发出 `system/init` 后显示实际模型。强度接受 `low`、`medium`、`high`、`xhigh`、`max`。
- **清理：** `once` 收尾和按名字 `delete` 都会停止受管进程、清理插件私有记录。Claude 自己保存的会话历史留在用户目录，删除回执标明 `nativeHistoryPolicy: "retain"`。

## 回报

`report_parent` 要求按 Result / Changes / Verified / Not verified / Decisions 分段，控制在 300 词内，负责汇总的助手提交一份报告。`ask_parent` 要求写清要定的决定、选项和建议。

普通输出、轮次结束和任务树空闲都不产生回包。DSH 助手一轮结束却没有 final 报告时，插件在同一任务里提醒它一次，提醒后仍没有 final 就停在 `awaiting_report`。失败或取消的轮次不提醒。Codex 目标的补充走自己的持久队列，没有这个提醒。

顶层一轮结束不等于整项任务完成。只有顶层助手显式提交 final 报告，插件才在子孙执行和原生通知全部收齐后转发正文，并为一次性助手清理整棵受管树。下属向直接父级汇总，不直接报告给调用方。

助手提问后的答复这样送达：DSH 的 `ask_parent` 当场结束这一轮，答复开启下一轮；Codex 助手提问后可以接着干不依赖答复的部分，答复受理后直接送进它正在跑的那一轮，轮次已结束就开新一轮；Claude CLI 的一轮不能中途插话，答复在这一轮结束后送达。问题还没被回答，或答复已受理但还没送进会话时，Codex 和 Claude CLI 助手提交的 final 报告会被退回，工具结果告诉它先等答复，任务保持打开。任务已经以 final 封口后才来的回答不会再送给助手，`answer` 的回执会写明 `answer-not-delivered`。

普通 Codex 聊天支持后台回包。当前桌面对原生 multi-agent v2 子代理调用者拒绝后台回包，遇到这种拒绝时插件显示 `native-callback-unavailable`，保留未送达的报告和原收件人，不再重复投递。

## 列表和查看

看全队用一次 `futureaide_list_agents`：有下属的名字返回 `team`，后代每人一行，包含相对根的路径、状态、运行时活动和文件数，文件数封顶时显示 `12+`。最多 30 行，超出以 `{more:n}` 收尾。两个成员同名时第二个起用 `名字#2`、`名字#3`。宿主读不到树时条目带 `treeError` 且没有 `team`，这表示未知，不表示没有下属。

看某个成员的对话用 `futureaide_inspect_agent({name, node})`。`node` 取 `team` 里的路径或成员名，路径优先，被省略成 `…` 的路径按前缀匹配。同名命中多个成员时以 `node-ambiguous` 拒绝并给出可用路径。

五个读工具和 `futureaide_create_agent` 默认返回精简结构，`detail: true` 时返回完整内容。

文件观察优先采用助手原生文件工具的成功结果。shell 写入靠任务前后的 `git status` 比对发现，这类条目标为 `attribution: unconfirmed`：同一时间别的进程或助手的改动也会出现，gitignore 覆盖的路径和非 git 目录看不到。覆盖不全时工具会说明，不把共享项目的全部改动归给某个助手。

`wait_agents` 遇到已自动退出的名字会返回 `notListed`，完成情况以已收到的结果为准。

## 生命周期细节

**一次性：** 一项任务里可以多次提问、回答和报告，非 final 报告不会结束任务。成功的 final 报告确认送达且整树收尾后，插件关闭实例、清理私有记录并移出名单。DSH 和 Codex 目标清理受管会话数据，Claude CLI 保留原生历史。取消只更新可见状态，不自动通知或清理。已提交的报告继续交付，助手可以按名字删除。清理失败仍显示在列表里。

**长期：** final 报告交付后回到空闲，下一项任务用原上下文。没有 final 时显示 `awaiting_report`，同名发送继续原任务。final 已提交但尚未交付时不接受追加消息。取消或失败后，没有待投报告的长期助手可以在同一会话开始新任务。主动删除会同时丢弃尚未交付的报告。

**失败：** 模型请求失败时，列表和查看结果里的 `error.source: "model"` 给出错误代码、可用的 HTTP 状态和简短提示。任务进入确定的失败终态时，插件给直接上级发一次失败通知。重试中不发，上级自己取消也不发。模型任务不会自动重试。新任务或后续成功会清除展示中的旧失败。

**取消：** 取消请求优先送到所属助手，不用等普通监工释放操作锁。`accepted` 表示宿主已接受，用列表确认任务树停止。取消不会撤销已经发生的操作。自动清理已经开始时，取消返回未接受。

## 监工和持久化

一个共享监工进程推进各名字的任务。任务树静止、没有执行中或排队输入的等待助手显示 `monitor: sleeping`，发送或回答会唤醒它。监听器通常在宿主持久记录变化时唤醒，约每 30 秒补扫一次待投递的报告和问题。所有插件连接和监听器都关闭时，下次连接恢复检查。

桌面目标的首次派发、忙时补充、取消和删除都是持久排队意图：受理后不重发，执行者或监听器中断后按原 `requestId` 恢复，已发出的不重放。

任务回执、问题、答案和待回包结果都持久保存。连接恢复后按原任务继续，不新建助手顶替。发送情况不明时先核对原生证据，回包情况不明时核对原聊天，不盲目发送第二份。

`delivery_pending` 表示工作已完成、结果等待交付，这时一次性会话尚未删除。已保存且具备交付条件的显式报告，可以在 DSH 暂时离线时继续交付。

## 安装范围

`install.ps1` 准备三样东西：Codex 插件、本机 DSH 主机桥接、Claude 用户级插件。

安装器在 `.runtime/claude-marketplace` 生成只含清单、MCP 配置和技能的薄插件，运行入口用绝对路径指向克隆目录，再执行 `claude plugin marketplace add … --scope user` 和 `claude plugin install futureaide-control@futureaide --scope user`。注册是用户级的，Claude 在任何项目的会话都能用，不用为每个项目写 `.mcp.json`。

- 找不到 `claude` 或注册失败不影响 Codex 安装，返回值里 `claude.registered` 是 `false` 并带原因。
- 桌面端自带的 `claude.exe` 不在 PATH 时，用 `-ClaudeCli <path>` 指定。不想改 Claude 环境时用 `-SkipClaude`。
- 自定义 DSH 数据目录用 `-DshHome 'E:\DSH-data'`，重装会保留已保存的选择。
- 私有配置和状态在克隆目录的 `.runtime/` 里，这个目录的位置要保持不变。

Claude 侧的桥接声明了 `tools.listChanged`：服务端的工具名或 schema 变化后，会向已打开的会话发 `tools/list_changed`，比对失败只记日志，不影响工具调用。

## 升级

从 0.4 升级到 0.5 前，先让运行中的任务完成。需要保留在途任务升级时，要按原任务身份切换后台 `scoped-worker`。只重新加载 MCP 不会替换已经启动的监工进程，也不要重新派发任务来代替迁移。

已加载的旧 MCP 模块在连接重新加载前仍走旧路径。

## 配置

宿主目标由 `target` 决定：`dsh`（默认）、`codex-desktop`、`claude-cli`。

DSH 路径未指定实例时只读 DSH 的注册记录，默认数据目录是 `DSH_HOME` 或 `~/.dsh`。旧 FutureAide 应用的 shell、端口、启动日志和环境变量覆盖一律不用。手工维护配置里的 `target` 只能是 `dsh`，已有 `auto` 或 `futureaide` 配置会明确报错，安装器会生成固定的 DSH 配置。

维护 CLI 默认用安装目录的 `.runtime/config.json`，`--config` 和配置环境变量可以显式选择其他配置。桌面桥接已绑定不同凭据或托管状态目录时，安装会报告冲突并保留原绑定，确定要迁移时才用 `desktop-host-install --rebind` 或 `connect-desktop.ps1 -Rebind`。

## `Transport closed`

每个聊天都有自己的调用连接和名单。一个聊天能用，不代表其他聊天的连接正常。工具直接返回 `Transport closed`，尤其 Codex 内置工具也失败时，要恢复 Codex 持有的连接。重新派发任务或只重启 DSH 不能代替这一步。

[recover.cmd](recover.cmd) 会完整退出 Codex 及其后台进程再重新打开，保留原启动路径和参数，不删聊天、名单或项目文件，也不重启 DSH。它会中断正在执行的聊天，要在合适的时候用，不要在 Codex 自己的终端或工具里运行。

只检查目标进程，不重启：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\recover-codex.ps1 -Check
```

重新打开后，在每个受影响的聊天调用 `futureaide_status({})` 和 `futureaide_list_agents({})`，核对原名单再继续。

运行进程清理工具时要保留存活 Codex 进程树内的工具。MCP 没有窗口、等待请求时不活动，都不表示已经没用。

安装配置下，新启动的 MCP 进程会在 `.runtime/diagnostics/` 记录精简日志，包含进程、工具名和聊天身份，不含任务正文、结果或凭据。

## 维护接口

原生会话清理支持上述 DSH 版本的 JSONL 会话、项目索引和派生缓存，不支持的存储后端会返回清理失败。整树清理支持本机原生 one-shot 和 continuable 下属，外部托管的下属会明确报告不支持自动清理。

显式 ID 的 CLI 仍可用于 DSH 维护，查看 `node src/cli.mjs --help`。需要这套 MCP 管理面时，在维护环境设置 `FUTUREAIDE_LEGACY_TOOLS=1`，它和默认名字工具面二选一。这里的 legacy 指维护接口，不表示仍支持旧 FutureAide 宿主。详见[旧版 CLI 与显式接口](skills/futureaide-control/references/legacy-workflows.md)。DSH 版本用的 slash 和 dot HTTP API 适配都保留，status 里的 `apiDialect: legacy` 只表示 slash 协议。
