# 更新记录

## 0.5.15 — 2026-11-07 · Claude CLI 目标，回报不再卡死

本版新增 `claude-cli` 目标，并修掉让名字永久锁住的回报问题。升级后监工第一轮会解开卡住的旧记录，超过 6 小时的旧通知不再推送，正文保留。

- 新增 `target: "claude-cli"`：用官方无头模式在后台运行 Claude Code，Codex 和 Claude 调用方都能按名字派单，支持 `model` 和 `effort`，长期名字续用同一会话。需要 CLI 自己的登录。
- 大线程不再超时：发送和观察改用轻量视图，完整内容只给 `inspect`，并逐轮分页。
- 回报确认有结论：读回读全且确认没有才重发一次，读不全不重发。30 分钟确认不了转 `blocked`，原因 `unconfirmed`；超过 6 小时的待发通知转 `blocked`，原因 `expired`。前一条未决通知不再堵住后面的最终报告。
- 只有最终报告真正送达，`once` 才自动清理；报告没送到时保留名字和正文。
- 上级派新任务不再被回包确认挡住，回执用 `previousReport` 带上上一份报告的摘要。
- `thread not loaded` 视为线程不在当前档案，通知转终态，不再无限重试。

## 0.5.14 — 2026-11-06 · 调用时选模型和思考强度

本版让调用方按名字选模型。没选过的名字行为不变，继续跟随目标应用的默认值。失败通知现在带上错误代码，比如 `QUOTA`。

- Claude 和 Codex 调用方都可在 `futureaide_run_agent`、`futureaide_create_agent`、`futureaide_send_agent` 中指定 `model` 和 `effort`。模型可按完整 ID 或片段匹配，解析结果随名字保存，后续派单、回答和提醒沿用。状态显示各后端的可选模型和默认模型，回执、名单和等待结果显示完整模型 ID。
- Codex 通过 `model/list` 读取可用模型和档位，显式选择在 `turn/start` 生效。未选模型的名字继续继承 Codex 默认值。正在运行的轮次要求等到结束后再更换模型或档位。
- 识别 Codex 首轮返回的带文件路径的空 rollout 错误，首次观察时按空记录处理。
- Windows 上并发读取短暂占用状态或回执文件时，重试原子替换，避免已接单的任务因写盘中断。

## 0.5.13 — 2026-11-05 · Codex 目标改走原生 RPC

本版把 `target: "codex-desktop"` 从 app-tools 的 `create_thread` 锚点方案换成 Codex 自己的 app-server RPC，会话和界面新建的对话一样，保住用户的模型、推理强度和审批/沙箱默认值。已在真实 Codex 26.1029.7803.0 上跑通 Claude 调 Codex、Codex 再调 DSH 的全链路；没有调试端口时退回 app-tools 的路径、Codex 重启后续用长期名字还未实测。

- 建会话：经主渲染进程的本地调试端口发 `thread/start`、首条 `turn/start`；首条消息把派单方的任务原文放最前，后面跟简短的 `ask_parent` / `report_parent(final=true)` 提醒，dispatch marker 放最后一行，不传模型、推理强度或权限字段。后续空闲发送用 `turn/start`，运行中补充用 `turn/steer`，打断用 `turn/interrupt`，删除用 `thread/delete`，冷线程先 `thread/resume`。标题不在首轮返回时硬设：绑定时记下待设标题，等投影有消息后再 `thread/name/set`，失败最多重试 5 次且不影响任务。
- 失败通知：任务进入确定的失败终态时，复用 report 的投递与去重给直接上级发一次通知，写明助手名、“执行失败”和简短原因；Claude 与 Codex 上级同一路径。通知作为任务内的报告条目进入既有候选扫描，首投遇到瞬时不可用会在后续扫描重试；terminal 错误也同样发一次，失败重试仍在进行时不发，上级自己 cancel 造成的停止不发。
- 稳定性：所有名字共用的原生 RPC 连接只在传输故障时重建，应用层拒绝不再关掉 socket 掐断别的名字；首派 unknown 超过 2 分钟且所有线程都找不到 marker 时转失败终态，由上级决定是否重派；`findCreatedSession` 只读、绝不 resume 用户线程；`status` 的 Codex 证据改为 `native-rpc`。
- 收尾：删除后的核对把 `thread/read` 的“thread not loaded”视为已删除；没有 binding 的名字直接算清理完成；首次 rollout 未写入时观察按运行中处理，不闪 reconnecting；后续消息的 marker 也放最后。README 与 SKILL 记录取消不会杀掉 Codex 已启动的 shell 命令。Codex 宿主身份只比较 `application`，旧记录的 `dataRoot` 不再参与比较；清理时 `thread not loaded` 和 `codex-thread-not-found` 都按已删除处理。
- 回包确认：Codex 发送只用 `notLoaded` 轮次页判断运行中，observe 用 `summary`，`full` 只由 inspect 对单轮 `thread/items/list` 分页读取；owner 读回先看最近 30 轮 summary，再逐轮最多 5 轮确认，确认缺失且超过 2 分钟才重发一次。未确认超过 30 分钟转 `blocked`（reason `unconfirmed`），6 小时未发转 `blocked`（reason `expired`），正文保留；前一条 unknown 不再堵住 final。`delivery_pending` 的名字可接受新任务，回执带 `previousReport`（delivered:false，摘要最多 300 字）。`thread not loaded` 纳入全局 missing 判定。
- 审核收口：只有 final 真正 `delivered` 才允许 once 自动清理；blocked final 保留名字和正文，persistent 回 idle，once 留在名单等手动删除。通知时间只认 report/task 的真实时间，缺失的真实旧通知按 `expired` 处理；owner 读回按 `nextCursor` 翻完候选轮次（每轮有上限，未读完不重发）；`turn/start`/`turn/steer` 明确成功即 accepted；inspect 截断时 `hasMore` 为 true。
- 观察：改用 `thread/read`、`thread/turns/list`、`thread/list` 组装状态、消息和文件改动；原生子线程按 `thread/list.parentThreadId` 入树，不再读 `state_5.sqlite`、`thread_history_1.sqlite` 或 rollout 文件。`thread/list` 的 `sourceKinds` 显式包含 subAgent 各类型。线程 `updatedAt`/状态未变时复用上轮结果，不重复拉 turns 和子线程；冷线程 resume 使用 `excludeTurns`，turn 页只取最新 20 条。
- 调用方验证与回报送达：Codex owner 的读取、问答/报告通知统一走一个入口，优先原生 RPC；桌面没有调试端口（`codex-native-rpc-unavailable`）时退回 app-tools，普通 Codex 对话调 DSH 的基础场景不变。写入失败不自动重试，结果不明仍走 `unknown` 语义；线程在当前档案不存在时通知转 `blocked` 终态、保留报告正文并在 list 给出原因，瞬时不可用继续等待重试。
- 状态与错误：`status` 的 Codex 就绪来自一次真实的 `thread/list` 读类 RPC；没有调试端口时给出 `codex-native-rpc-unavailable`，文字提示从 FAswitch 打开 Codex。当前档案里看不到受管线程时返回 `codex-thread-not-found` 并终止该任务的重试，不再无限轮询。
- 删除：删掉锚点解析、`create_thread` 路径、`state_5` / rollout 读取函数和 `thread_source` / `agent_created_thread` 删除保护。删除保护改为核对名单绑定与线程 `cwd`，并沿 `thread/list.parentThreadId` 核对整棵受管树。
- 测试：新增按 app-server v2 schema 形状构造的假 RPC 测试，覆盖创建参数、无模型/权限字段、运行中 steer、冷线程 resume、父线程过滤、删除顺序、缺失线程终端语义、调用方验证与回报送达的 RPC 优先/回退。

## 0.5.12 — 2026-11-05 · 移除 Claude Desktop 目标和窗口操作

本版只做减法：插件不再操作用户的桌面。执行目标只剩 DSH 和 Codex Desktop，Claude 只当调用方。Codex 因此也调不起 Claude 会话了，Claude 这边只服务受管会话的 `ask_parent`、`report_parent` 一并删除，Codex 这边的保留。升级后需要重启监工，新进程才会停止列出这个目标。

- 移除 Claude Desktop 执行目标和全部界面自动化：`target: "claude-desktop"` 不复存在，模拟鼠标、键盘、剪贴板并切换前台窗口的那套实现（`claude-host`、`claude-backend`、`claude-observer`、`claude-tree` 及其脚本与测试）一并移走。原因是它要操作用户真实的 Claude 窗口：会切走前台窗口，还可能点停用户正在用的会话。Claude 作为调用方派单给 DSH / Codex Desktop 的能力不变；名单里已存在的 `claude-desktop` 历史记录仍能正常列出，新建时明确拒绝（invalid-target），对它做需要后端的操作返回 backend-not-ready。

## 0.5.11 — 2026-11-04 · 派单结果和提问传得回来

本版修两个让派单方收不到东西的问题，只对升级后新建的任务生效，已在等待中的历史任务不会被提醒。

- 派单结果回不来：DSH 助手的一轮结束却没有提交 final 报告时，现在会收到一次提醒（`FINAL_REPORT_REMINDER`，走 supplement，同一轮继续）——条件是不失败的终态、任务与观测里都没有 final、任务带 `finalReminder: armed` 标记（只有 `send` 新建的任务才带，升级前就在 `awaiting_report` 的旧任务不会被唤醒）、目标是 dsh 且没有排队中的补充。标记在发送前落盘，崩溃不会重发；提醒这一轮不发主控通知，任务保持 running；这一轮仍没有 final 就正常进入 `awaiting_report` 且不再提醒；提醒是尽力而为的：它的 dispatch 带 `reminder` 标记，不参与“任务是否结束”的判断，未决或失败的结果也不会让任务一直 running 或无法休眠；发送失败或结果不明只是这条提醒没送到，已结束那一轮的结算与任务状态不受影响，也不会重试。

- 提问走错通道：DSH 自带的 `ask_user_question`（及旧拼写 `request_user_input`）会把问题弹在 DSH 窗口里，派单方看不到，任务一直卡着。托管代理与它的原生下级现在被 `tools.guard` 拦下：根代理提示改用 `ask_parent`，下级提示用 `send_message` 发给父级；下级的 guard 另外装在它自己的作用域里，因为 DSH 的 guard 沿 agent 作用域链生效、下级不保证继承到根代理那一条。plan mode 的 `userQuestions`（`exit_plan_mode` 的计划确认）走同一 UI 通道，暂时没有拦截。

## 0.5.10 — 2026-11-04 · 适配 DSH 0.2.2 与工具调用提速

升级到 DSH 0.2.2 时请同时升级本插件：旧版插件在 0.2.2 上恢复不了旧会话，也投递不了最终报告。实测读类工具单次调用从约 3.5 秒降到约 0.5 秒。

- 适配 DSH 0.2.2-rc.1（nightly）：新版删掉了内部接口 `sessionController.inspect`，插件改由模块级 `readStoredSession` 读取存储会话，优先 `controller.inspect`，没有时用 `sessionQuery.readSession`（返回 `{session, events}`）；恢复旧会话、任务树检查、`managedHistory`、带后级的 `managedDestroy`、`resolveAgent`、`historyCursor` 六个调用点都走同一条路径，两种接口都缺时明确报 `managed-session-inspection-unavailable`。未知宿主异常另外写入 `managedStateDirectory` 上一级的 `host-last-error.json`（不含 bridge token，写入失败也不改变返回结果）。
- 新增兼容探针：`host-plugin.mjs` 导出 `DSH_INTERNALS`（凭代码梳理的全部 DSH 内部接口，二选一的按“都缺才算缺”）与 `checkHostCompatibility`，`ping` 返回 `compatibility`；`status` 的 `backends.dsh` 在缺失时给出 `ready:false`、`missingInternals` 与 `dsh-internals-changed`，DSH 升级后会直接显示缺什么，而不是等任务卡住。
- 工具调用提速：Claude 侧 HTTP 服务把 `keepAliveTimeout` 提到 10 分钟，空闲连接仍保留调用方身份，一次工具调用不再每次多花约 3 秒做父进程与启动时间查询；socket 关闭后身份照旧失效，`close()` 会主动断开空闲连接，不被长连接卡住。

## 0.5.9 — 2026-11-04 · 精简输出、团队视图与事件驱动监工

本版让主控用起来更省：一次调用开工，工具默认只回决策需要的信息，一次 `list` 看全整棵树，回报格式统一。名单存储有一次自动迁移，升级后首次打开时在事务内完成，不需要手工操作；要退回旧版本，先把 `agent_history` 回填进记录，否则旧版看不到历史任务。

- 工具输出精简：调用方是模型，答案直接进上下文，所以 `futureaide_status`、`futureaide_create_agent`、`futureaide_list_agents`、`futureaide_wait_agents`、`futureaide_agent_changes`、`futureaide_inspect_agent` 现在返回精简视图。列表条目原本 1～4KB，同一份报告最多重复三遍（`task.result.summary`、`reports.latest.summary` 与正文），现在只保留名字、状态、生命周期、任务、待答问题、最新报告、改动文件计数和树规模：报告文字只出现一次，仍有未送达报告时 `report.pending` 报出数量，只有监控停止时才显示 `monitor`；文件计数包含 unconfirmed 路径并另给精确总数（不受 12 条摘要截断影响）；`inspect` 不再把根节点消息列两遍，超长消息截到 4000 字并标 `truncated: true`；`status` 去掉各后端的 `methods` 列表；`changes` 的覆盖率压成一句话（`note`），历史任务保留其任务文本，比对超过 200 条时在 `coverage.workspace.truncated` 与 note 里写明只列了前 200 条。精简输出不缩进，长度保护与之前一致。
- 五个读工具（`status`、`list_agents`、`wait_agents`、`agent_changes`、`inspect_agent`）都接受 `detail: true` 取回完整结构；服务层返回结构未变，`isError` 仍按完整结果判定（`created: false`、`ready: false` 等不会被视图掩盖）。
- 新增 `futureaide_run_agent`：一次调用完成创建与派单，名字已存在时直接发给它；省略 `name` 时生成“助手-”加 4 位十六进制，撞名重新生成。调用方显式传 `target` 或 `lifetime` 且与已有记录不同时报错，说明这个名字绑定的是哪个应用和生命周期，不静默用错目标；创建失败原样返回且不再发送；新建成功但首次发送抛错时，仍返回这个名字和 `created: true`，避免自动生成的名字丢失。返回 `{name, lifetime, state, accepted, queued?, retrying?, error?}`，新建带 `created: true`，复用带 `reused: true`。
- `changes` 不再带回文件正文：实机上 7 个新建文件曾回约 20KB。默认每条只留 `path`、`operation`，根以下的 `agentPath` 和 `unconfirmed` 归属才保留，正文与来源只在 `detail: true` 时出现；`inspect` 的每个节点也不再重复顶层文件清单。
- 新增团队视图：`list` / `wait` 里树节点多于一个时，用 `team` 数组取代原来的节点计数，每个后代一行（相对根的 `path`、状态、运行时活动、文件数），最多 30 行并以 `{more:n}` 收尾，单行不超过 120 字节。上级一条 `list` 就能看完整棵树。
- `inspect` 新增 `node` 参数（成员名或 `team` 里的路径）：只返回该节点的对话，其他节点只留名字和状态；找不到时明确报错并列出可选节点。`detail: true` 时同样按 `node` 过滤。
- 新增 `src/report-contract.mjs`：三方 `ask_parent` / `report_parent` 说明里嵌入同一份回报与提问契约（Claude 走 `claude-report-server.mjs`，Codex 走 `mcp-server.mjs`，DSH 在 `host-plugin.mjs` 内联并由测试逐字比对）。DSH 说明里的“controlling Codex agent”改为“controlling agent”，上级不一定是 Codex。
- Claude 桥接声明 `tools.listChanged` 并每 45 秒（不低于 30 秒）比对服务端工具列表，工具名或 schema 变化时发 `tools/list_changed`，已打开的会话不必重开；比对只在服务已经 ready 时进行（绝不因此拉起监工），并且用一条独立短连接，失败不会碰会话正在用的客户端，所以不会把在途写变成 write-outcome-unknown；比对失败只记日志，不影响工具调用。
- 监工减负：`history` 从记录正文移到 `agent_history` 表（打开数据库时在事务内幂等迁移，删除名字时一并抹掉），内容没变的保存不再写库，名单投影按 `data_version` 缓存。循环改为事件驱动：文件事件只轮询被点名的名字，其余每 5 秒兜底，跨进程提交 1 秒内发现，待投递回报按各自的退避时间重试。实测在 6 个助手运行时，监工从 55～62% 单核降到约 20%，final 到进对话从 3～5 秒降到约 2 秒。
- 投递连续失败超过 20 次后，重试上限从 30 秒放宽到 5 分钟，父聊天已不在时不再每 30 秒试一次。Codex 桥的发现结果缓存 15 秒（失败 5 秒），不再每次调用都枚举全部进程。
- 列表条目在树读不到时带 `treeError`（此前只剩 running、team 为空，会被读成“没有下属”）；团队 `path` 现在可寻址：同名成员第二个起编号 `#2`、`#3`，`inspect` 的 `node` 用同一套编号，路径优先、省略路径按前缀匹配、同名命中多个成员时以 `node-ambiguous` 拒绝并列出可用路径。团队行的文件数在封顶时显示 `12+`，`activity` 截到 40 字符，单行仍控制在 120 字节内。
- `inspect` 的 `detail` 与 `node` 组合时，`hasMore` 与 `note` 改用选中节点自己的（此前会串用根页字段）；`inspect` 的覆盖率提示改为“Showing n of m paths; changes lists them.”，“只列前 200 条”只留在 `changes` 工具里。
- `futureaide_run_agent` 遇到正在清理或已关闭的名字时返回 `name-closing` 并说明该等它离开列表还是换名字，不再转述 send 的含糊报错。
- `list` / `wait` 整体超过 40000 字符时，先把每个 `team` 换成 `teamSize` 计数并加提示，仍超才退化成 preview，避免满员团队时读不到任何条目。
## 0.5.8 — 2026-11-04 · Claude 调用 DSH 与用户级插件

本版主要能力是 Claude 调用 DSH，已完成实机验证。Codex Desktop 与 Claude Desktop 作为被调用目标（`target: 'codex-desktop'`、`'claude-desktop'`）仍是实验性的：功能已经具备，后续继续完善，本版不按完成计。

- 创建工具新增可选 `target`：`dsh`（默认，行为不变）、`claude-desktop`、`codex-desktop`；其后所有操作仍只按名字寻址，不暴露原生会话 ID 或内部协议。
- 后端边界抽成共享方法集：DSH、Claude Desktop、Codex Desktop 共用同一套名单、任务、问答、报告与清理状态机；`status` 一次报出各目标是否就绪。
- 桌面目标（Claude Desktop / Codex Desktop）的首次派发、忙时补充、取消与删除为**持久排队意图**：受理后不重发；执行者或监听器中断后按原 `requestId` 恢复原请求，已发出的不重放。
- 受管子代理侧提供 `ask_parent` / `report_parent`；跨应用下属的汇总与最终交付只走显式报告，普通输出与轮次结束不产生回包。
- 模型在每次输入派出时跟随各宿主的当前默认设置，不逐条改写名单记录；一次性代理的 `once` 使用宿主原生删除，项目产物保留。
- 共享监控改为单进程按需保活，支持同名并行 inflight、异步首派/补充/取消/删除意图、退避与可见错误；新增跨源任务树结算与清理快照。

- 修复 Claude 实际模型菜单导航、输入前窗口和完整请求标记核对、仅对确定的发送前失败恢复；写入结果不明继续保留原请求以核对。
- 修复 Claude 会话重启后回报发不回来：记录文件缺失或进程已死都判为绑定失效，刷新后的绑定写回名单，确定没写出去的通知才重发；`status` 的回传通道按实际绑定核验。
- 修复收到 final 后马上派单被拒：回执确认前继续轮询、不进入 sleep，派单时先读回确认，窗口从最长 59 秒降到几秒。
- 修复忙时补充被吞：DSH 的补充改走 steer，模型下一步就能读到；有待读输入时拒绝 final，避免补充晚于 final 到达后再也回不到主控。
- `changes` 现在能看到 shell 写入：任务前后比对 `git status`，结果标为 `unconfirmed`，对三种目标都有效，非 git 目录和 gitignore 路径在覆盖说明里写明。
- 修复删除与一次性清理超时：宿主不再等待 DSH 全量索引对账（DSH 每次搜索前会自己对账）；结果不明的删除和忙碌的下属保持 `cleaning` 并自动重试，不再记为 `cleanup_failed`。
- 修复子代理结束后后台 PowerShell/Bash 命令被遗漏的问题：后台任务参与树结算与取消，以原生任务通知确认停止。
- 修复补充消息重试阻挡已有报告与问题的推进；Codex 进程发现使用系统 PowerShell 绝对路径，不依赖 Claude 的 PATH。
- 增加任务父级及生命周期索引，避免监控完整解析历史；Codex 就绪探测短时复用，每次真实派发仍读取当前默认模型。
- `install.ps1` 现在把 FutureAide Control 注册为 Claude 的**用户级插件**：在 `.runtime/claude-marketplace` 生成只含清单、MCP 配置和 skill 的薄插件（用绝对路径指向 D 盘运行目录），再依次执行 `claude plugin marketplace add … --scope user` 与 `claude plugin install futureaide-control@futureaide --scope user`。任何项目的 Claude 会话都能按名字调用 DSH 子代理，新开会话时生效；找不到 `claude` 或注册失败不影响 Codex 安装，可用 `-ClaudeCli <path>` 指定桌面端自带的 `claude.exe`，或用 `-SkipClaude`、环境变量 `CLAUDE_CLI` 控制。

本机验证（2026-11-04）：正式入口的 12 个工具已加载，Claude 调用 DSH 的全链路实机通过。正向 Claude 完成 create/send → ask/answer → Write → 显式 final → once 原生删除、产物保留；反向 Claude → Codex 完成普通回复留在同任务、补充、问答、原生 apply_patch、显式 final、once 原生 thread/delete（SQLite 与 rollout 消失）并回到 Claude。长期 Claude 跨任务保留口令并生成精确产物，下一次输入跟随宿主当前默认档位。公共取消停止 Claude → Codex → DSH 混合树；后台 shell 最小复验收到原生 stopped 通知并在自然结束前退出。性能实测 status 暖调用 9933ms → 37ms；4 running/39 sleeping 时监控单核 CPU 94.7% → 30.1%。本版验证结论与未完成项见 [README](README.md#本版验证结论2026-11-04)。Codex 与 Claude 互调目标的上述链路在本版最终改动后尚未重新验证。

安装器的 Claude 注册只生成薄插件，运行目录与状态仍放在安装目录；Codex Desktop 注册不在安装器内，需要单独配置。整应用退出再打开后的自动恢复尚未实机验证，已有的原请求恢复和监控切换保留原任务身份。

## 0.5.7 — 2026-11-01 · 默认模型跟随与派单去重

- 托管代理每次新任务、补充与回答接续采用 DSH 当前默认供应商、模型和推理档位；旧代理创建时保存的模型不再覆盖当前默认设置。
- 读取原生会话实时选模；实际模型未变时跳过选模，历史名单的保存值不作为跳过依据。每次输入持有独立选模回执，同一任务可多次切换供应商。
- 复用本次任务开始或状态查询取得的游标，省去额外游标请求；创建空代理不再补取模型目录。
- 目录读取失败保留原派单进行后台恢复，已确定的模型随该输入保留；不新增全会话扫描、失败任务重放或闲置代理批量唤醒。DSH 原生下属继续按自身继承与显式选择规则使用模型。

## 0.5.6 — 2026-11-01 · 模型失败原因可见

- 列表、等待和查看代理时显示模型轮次的简短失败原因，区分模型执行失败与连接错误；例如 HTTP 503 / `no_healthy_account`。
- 错误只包含类别、稳定代码、HTTP 状态及简短提示，省略上游完整响应、请求体和凭据；新任务或后续成功不会显示旧失败。
- 已有失败记录可在正常查看时用本次已读取的原请求事件补齐原因，不增加历史请求、自动重派或自动失败回包。

## 0.5.5 — 2026-11-01 · 定点派单/监控与轻量巡检

- 受管模型选择、发送、等待、读取与监控改用绑定 DSH 会话的 `managedStatus` / `throughSeq` / `read` 定点读取路径，不再反复列出全部会话。
- 写入前读取超时记为 `retrying`；后台 worker 沿用同一原请求 ID 恢复，调用方无需重发。
- 原生写入结果不明保持 `unknown`；重试前核对原回执和原收件人，绝不盲目重复。
- 普通/旧调用路径及跨 task 恢复语义保持不变。
- 修复 0.5.4 每个 MCP 连接每 30 秒完整解析全部代理记录造成的持续内存增长：正常健康检查改为数据库存在性查询与租约检查，恢复、休眠扫描和待投递轮询只取生命周期投影，不再读取任务、报告和历史正文。
- 只有实际恢复某代理或轮询某条待投递时才加载该代理的完整记录；单条历史高达数 MB 时，多连接巡检的常驻内存不再随全表历史线性累积。
- scope 隔离、任务/问答/回执、补充队列、取消、`wakePending`、共享监听器以及旧 MCP 跨 task 恢复语义保持不变。

## 0.5.4 — 2026-11-01 · 闲置监工休眠

- 已确认静止且无执行中或排队输入的等待代理可休眠独立监工；共享监听器按持久状态变化唤醒，定期补扫并接续待投递报告及问题。

## 0.5.3 — 2026-11-01 · 忙时补充排队

- 监工持锁时，当前任务的补充消息可持久排队并按顺序恢复；本地排队与 DSH 实际受理分别显示。

## 0.5.2 — 2026-11-01 · 精简发送回执

- 发送任务和补充消息只返回受理状态及必要错误；任务树、文件和报告按需查询。

## 0.5.1 — 2026-10-31 · 优先取消与停止确认

- 取消请求优先送达宿主，不再等待普通代理操作锁；按任务身份持久记录并在普通操作结束后重新确认停止，保留待交付报告和历史。
- 桌面对原生 multi-agent v2 子代理拒绝后台回包时，明确显示 `native-callback-unavailable`，保留原报告及收件人并停止重复投递；普通聊天回包不受此限制。

## 0.5.0 — 2026-10-31 · DSH自主汇报与正式交付

- DSH 顶层助手通过 `report_parent({message, final: false})` 自主提交进度，`final: true` 提交最终报告；附极短代理名/报告类型前缀后转发明确正文，不自动附文件 JSON 或回复指令。
- 普通回复、轮次结束及树空闲不再唤醒 Codex；未提交 final 时显示 `awaiting_report`，同名发送继续原任务。
- 报告先持久保存、按稳定身份去重恢复；final 等整树收尾后交付，成功的一次性任务随后清理整树。取消和失败只更新可见状态，不自动通知或清理，已提交报告仍可靠交付。
- 新报告协议阻止旧 caller 按旧空闲语义收尾；升级需要重载插件/MCP 并更新后台 worker。接管原任务不重新派发，旧自动结果缓存不转换为显式报告。

## 0.4.0 — 2026-10-30 · 多层级 DSH 子代理与桥接修复

- 宿主选择收窄为 DSH，默认使用 `DSH_HOME` 或 `~/.dsh`；移除旧 FutureAide 应用的自动发现、运行日志/端口文件和旧环境变量覆盖，不再接受 `target: auto` / `futureaide`。
- 显式实例须标识原生 DSH，失效或无效时不转向其他应用；保留 DSH 维护 CLI、现用 slash / dot API 适配、工具名称及存量状态字段。
- 本项是宿主兼容清理，不是 `Transport closed` 根因修复。
- 补充断连调查结论：本次现场由独立定时清理器误杀静默 MCP 引发，已在该清理器中修正并恢复调用。说明先停止误杀、再重建已关闭连接；不将 worker 修补或重启入口混称为根因修复。
- 修复维护入口与正式安装使用不同默认配置的问题：维护 CLI 优先使用本安装的 `.runtime/config.json`；找不到安装配置时明确报错，避免无意创建另一份桥接凭据。
- 桌面桥接安装在写入前检查已有凭据和托管状态目录，拒绝静默改绑；显式迁移使用 `--rebind`，同一绑定仍可正常热更新和 `--refresh`。兼容 DSH 将长路径写成双引号反斜杠折行，避免合法绑定被误判无法验证。

- 受管 DSH 代理可通过原生委派工具继续创建下属，插件不设固定层数上限；Codex 仍只按顶层名字调用。
- 列表、文件变更与深入检查覆盖受管树；文件附 agentPath，子孙历史通过受血缘校验的只读入口读取。
- 完成等待下属执行、原生通知与顶层最终汇总；取消清空整树待处理输入，长期根可继续复用；一次性回包后清理本机受管子孙。
- 热更新保留尚未协商多层协议的旧单层任务；新客户端以内部协议防止提前回包或清理，不增加调用参数。
- 已通过真实三级委派、文件归属、取消后复用和子孙历史读取验证；早期隔离测试曾出现原生轮次持续运行，后续两轮未复现，原因尚未确定，不将其列为已修复。

## 0.3.1 — 2026-10-30（原始断连仍在排查）

- 修复后台 worker 启动失败时异步错误未被捕获、可能带崩 MCP 进程的问题；失败保留原任务和状态，释放对应租约以供后续重试，不覆盖其他调用的新状态。
- 增加本机 MCP 进程生命周期诊断，记录启动、工具调用边界、stdin 关闭和退出信息，供定位原始断连；不记录任务正文、结果或凭据，不改变关闭语义。安装配置的日志位于 `.runtime/diagnostics/`。
- 新增独立的 `recover.cmd` 和只读 `-Check` 入口，MCP 断连时仍可从文件资源管理器启动。由用户选择后完整重启 Codex，保留原启动参数；不删除保存的数据，不重启 DSH。
- 说明多聊天连接可能分别失效，恢复后应逐个原聊天核对状态和名单；不以独立诊断连接成功代替原聊天恢复。
- 此入口是恢复手段，不是 Codex 关闭旧连接的根因修复；未启用会中断其他聊天的自动重启。

## 0.3.0 — 2026-10-30

### Codex 名字式子代理

- 默认 MCP 入口改为 10 个名字式工具，自动绑定当前 Codex 聊天与项目；每个聊天拥有独立名单。
- 创建时只需名字和 `once` / `persistent`，创建本身不启动模型轮次。
- 直接发送任务文字，DSH 通过原生 `ask_parent` 提问，Codex 按名字回答并继续原任务；正常最终回答自动回传，无需通信文件。
- 列表提供任务、活动、问题和文件变更摘要；详细差异与上下文按需查看。

### 生命周期与恢复

- 一次性任务在成功、失败或取消结果确认送达后，自动清除原生会话及插件私有记录并退出名单，保留项目产物。
- 长期代理完成后保持空闲与原上下文，后续任务可继续复用；按名字删除时清除会话数据。
- 持久保存派发回执、问答和待回包结果，支持连接恢复、宿主重启与桥接热更新后的任务接续；投递状态不明时先核对原记录。
- 列表和回包只附文件摘要；详细文件内容留在变更查询中。已退出名字在等待结果中标记为 `notListed`。

### 安装与兼容

- 提供 `install.ps1`，准备依赖并配置完整 Codex 插件与 DSH Host 桥接，运行入口固定在非 C 盘安装目录。
- 运行环境要求 Node.js 24.14 或更高版本；当前一键安装面向 Windows Codex Desktop 与 DSH Desktop 的 `desktop` profile，会话清理适配 DSH 0.2.1-rc.3。
- 安装或升级后重启 Codex，使当前聊天加载新工具。
- 保留旧 CLI 和显式启用的旧 MCP 维护接口。其他客户端需要聊天上下文及回传适配，不自动具备新版 Codex 工作流。
