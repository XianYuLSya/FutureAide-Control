# FutureAide Control 详细说明（v2.4.0）

本文补充 [README.md](README.md) 未展开的底层机制、参数细节与运行边界。日常使用阅读 README 即可。

## 1. 主对话核验与执行目标

### 调用方身份核验
插件在每次工具调用时从传输层核验主对话身份（`antigravity`、`codex`、`claude-desktop` 或受管下级 `managed-cli`）与所属工作区目录，自动隔离不同会话的花名册，**绝不从工具参数接收工作区路径、会话 ID 或桥接凭据**。

### 可用执行目标（`target`）

1. **`codex-cli`（默认主力无头后端）**
   - 后台执行 `codex exec --json`（首轮）与 `codex exec resume`（后续轮次/答复续接），挂载当轮专属的极薄回调 MCP 通道。
   - 子进程树纳入 Win32 Job Object（`KILL_ON_JOB_CLOSE`），取消、超时或监工退出时整树回收，不留孤儿命令。
   - 从 JSON 事件流实时提取最新执行步骤（`lastStep`）与 Token 用量（`usage`）。
2. **`claude-cli`（无头 Claude 后端）**
   - 后台执行 `claude -p`，以 `--session-id` 初始化、`--resume` 续接同一会话。
   - 权限固定使用 `--permission-mode auto --permission-prompts none`；仅读取 CLI 自身登录态（`claude auth status`），不读取桌面端凭据缓存。
3. **`agy-cli`（无头 Antigravity 后端）**
   - 后台执行反重力无头 CLI 轮次，复用同一套 `<50ms` 回调桥、Job Object 进程笼、Git `worktree` 隔离与 `cli-proxy` 出口门禁。
4. **`codex-desktop`（按需桌面原生 RPC 后端）**
   - 经 FAswitch 启动的 Codex 渲染进程调试端口调用原生 `thread/start`、`turn/start`、`turn/steer`、`turn/interrupt`、`thread/delete` RPC，不直读 Codex 私有 SQLite 或 rollout 文件。

> **底层历史兼容（`dsh`）**：早期版本的 `dsh` 目标仅保留底层协议与存量记录只读兼容，不再用于常规新任务派发。

---

## 2. 角色自动排号、模型选档与隔离分支

### 角色原名自动排号与可选预设表
在 `futureaide_run_agent` 或 `futureaide_create_agent` 中传入 `role`（如 `"backend"`、`"frontend"`、`"lead"`、`"后端"`）：
- 若省略 `name`，插件在当前主对话花名册内按你传入的 `role` 原名自动递增排号（`backend1`、`backend2`……）；批量 `tasks` 派发时按顺序无碰撞分配，绝不改写你的角色名。
- 默认直接跟随目标 CLI 自身配置的默认 `model` 与 `effort`；如需自定义角色到后端/模型的映射，可在 `~/.config/futureaide-control/roles.md`（或环境变量 `FUTUREAIDE_ROLES_CONFIG`）放置可选预设表，调用时显式传入的字段优先级更高。

### 模型与思考强度（`model` / `effort`）
- `model` 大小写不敏感，优先精确匹配完整模型 ID，其次匹配唯一或首个子串；无法匹配时返回可选模型列表，绝不静默退回默认模型。
- `effort` 可单独传入；省略时依次读取角色默认、`config.json` 的 `modelDefaultEfforts[modelId]`、`defaultEffort`。模型不支持请求档位时自动收敛到最近支持档，并在 `detail: true` 下保留完整选档证据。

### Git `worktree` 隔离与一键合入（`merge`）
- 派单时设置 `worktree: true`，插件在项目 `.work/worktrees/<名字>-<短哈希>` 下创建独立 Git 工作树，将该成员的工作目录切换到隔离树内执行。可传完整提交 `baseSha` 固定基线，批量项可以覆盖外层 SHA。
- 验收通过后调用 `futureaide_team({ action: "merge", target: "后端1" })`，插件将隔离工作树中的新增/修改/删除变更合回主工作区，随后移除临时 `worktree` 目录并标记合入完成，精简回执返回 `{ action: "merge", ok: true, summary, mergedFiles }`。

### 单次执行超时护栏（`timeout_minutes`）
- `futureaide_run_agent`（及批量 `tasks` 单项）支持可选 `timeout_minutes`（整数 `1`–`240`），透传为任务级超时上限 `timeoutMinutes`。超时触发后自动终止对应进程笼并标记明确失败原因，防止异常死循环空烧额度。

---

## 3. 回调契约、零轮询等待与忙时投递

### `<50ms` 回调桥与汇报契约
- 受管成员通过 `ask_parent({ message })` 提交待拍板问题，通过 `report_parent({ message, final })` 提交阶段进展或正式终报（`final: true`）。
- 普通对话文本或单轮自然结束**绝不**触发完成通知，只有 `report_parent(final: true)` 才代表正式交卷。
- 存在未答复的 `ask_parent` 提问或尚在投递途中的答复时，无头 CLI 与 Codex 成员提前提交的 `final: true` 会被拦截退回，确保答复不落空。
- 派单回执自带 `wakeCmd`（`futureaide-wait` CLI 命令）；主对话后台挂载该命令或调用 `futureaide_wait_agents({ taskKeys, barrier: "all" | "any" })` 即可实现零轮询事件唤醒。

### 忙时 `mode` 与 `delivery` 状态说明
- `mode` 支持省略、`"steer"`（插进当前活动轮）与 `"queue"`（排到当前轮结束后单独开下一轮）。
- 无头 CLI（`codex-cli`、`claude-cli`、`agy-cli`）在运行中仅支持轮间排队，忙时显式传 `mode: "steer"` 会返回 `mode-unsupported` 与 `supportedModes: ["queue"]`。
- 当存在待答提问时，显式 `mode: "queue"` 只排入后续补充，绝不代答问题。

---

## 4. 极简输出视图与紧凑 Token 账单

为极致节省主对话上下文，所有管理类工具默认返回单行无缩进的精简 JSON（传 `detail: true` 可取回完整原始结构）：

- **紧凑耗时与 Token 账单（`usage`）**：当成员或事件记录了有效耗时（`durationSec > 0`）或 Token 数（`totalTokens > 0`）时，精简视图自动输出紧凑字符串，例如 `"usage": "18s · 14.2k tok"`（百万级自动格式化为 `"1.25M tok"`）；若尚无用量记录则完全省略该字段，零冗余字节。
- **真实动作过滤与卡顿预警（`activity` / `stalled`）**：`futureaide_list_agents` 自动剥离 `"running"`、`"waiting"` 等无信息量的状态复读，仅保留真实工具/命令步骤（如 `"8s前 · shell:node --test"`）；运行轮次静默超过阈值时自动附带 `"stalled": true`。
- **三级列表视角（`scope`）**：
  - `"team"`（默认）：当前主对话的团队树（下属最多展示 30 行紧凑摘要，单行 ≤ 120 字节，超出计入 `{ more: n }`）。
  - `"agent"`：聚焦单名成员的完整待答问题、最新报告、改动文件清单与上下级位置。
  - `"all"`：按发起者会话分组展示全机活跃团队。
- **超长报告分页读取**：若报告原文极长被摘要截断，可用 `futureaide_read_report({ task_key, submission_ref, offset?, limit? })` 按 `nextOffset` 逐页读取完整原文。

---

## 5. 团队黑板、整队治理与代理防跑偏

### 托管 CLI 工具权限

普通开发与调查成员可以问答、反馈和读写黑板。审查员（`reviewer` / `审查员`）还可以派新的只读 Codex CLI 调查员（`scout` / `调查员`），并查询、答复或取消这些调查员子树的任务。团队长/领队（`lead` / `团队长`）可以在自己的后代范围内派单和治理。回环服务按当前任务和轮次核验身份，桌面与托管 CLI 各用独立凭据。

### 精确答复

`futureaide_answer_agent` 接收 `question_id` 或 `questionIds`。两者选一，数组内每个 ID 都须唯一且仍待答。省略选择器只答最早一条。CLI 等价入口为 `team answer NAME --message TEXT --question-id ID`，可重复传 `--question-id`。普通补充与黑板消息保留待答问题。

### 团队会议室黑板（`futureaide_board_post` / `futureaide_board_read`）

主对话可以对本队成员发送 `urgent: true`，托管团队长、领队和审查员限自己的后代。发帖前核验本帖全部点名对象。紧急消息可打断无头 CLI 当前轮，在同一任务继续，原待答问题保持待答。`board post MESSAGE --urgent --conv ID` 为命令行入口。
- 同一项目团队共享会议室消息流（`seq` 单调递增）。
- 发言中带 `@成员名` 或 `@团队长1/后端2` 时，插件自动解析跨级路径：对空闲成员发起新轮唤醒，对已完成退出的成员按原会话历史复活续跑，并在精简回执的 `woken` 数组中列出实际唤醒名单。

### 整队治理（`futureaide_team`）七大动作

| `action` | 关键参数 | 作用说明 |
|---|---|---|
| `"adopt"` | `target?: "auto" \| 名字`, `parent?`, `message?` | 接班收编同项目下旧会话遗留的整支队伍，或将指定散人拉入当前团队 |
| `"kick"` | `target`, `keep_children?: boolean`, `discard_worktree?: boolean` | 移除成员；默认 `keep_children: true` 保留其下属并自动提拔挂到上级名下，`false` 则连同整棵子树一并终止 |
| `"reparent"` | `target`, `parent: 名字 \| null` | 调整成员汇报上级（传 `null` 挂回 Boss 根下） |
| `"resume"` | `target`, `message?` | 在 FAswitch 切号、网络闪断或卡顿后，带着原上下文原地断点续跑 |
| `"strays"` | — | 列出父节点已关闭/缺失或原主会话失联超时形成的无主散人 |
| `"sweep"` | — | 安全清扫当前处于非运行态的无主散人记录 |
| `"merge"` | `target` | 将成员隔离 `worktree` 的文件变更合回主工作区并清理临时工作树 |

### CLI 端口代理门禁（`futureaide_cli_proxy`）
- 支持对 `codex-cli`、`claude-cli`、`agy-cli` 或 `all` 查看（`status`）或绑定（`bind`）代理。绑定值 `faswitch` 跟随激活档案，`direct` 启用直连。
- 只要解析出代理地址，每次拉起无头 CLI 前都会执行本地 TCP 连通性探针，**探针不通或档案错位立即拒绝启动（Fail-Closed）**，绝不退回裸奔直连。

### 本地只读状态看板（可选）
`config.json` 中将 `teamBoard` 设为 `true` 并重启监工后，可在本地访问 `http://127.0.0.1:<监工端口>/board` 查看只读花名册状态页；默认关闭时不加载任何页面资源。

---

## 6. `Transport closed` 恢复与维护接口

### `Transport closed`
当 Codex 客户端的 MCP 管道意外断开并报 `Transport closed` 时，可在资源管理器双击运行 [recover.cmd](recover.cmd)（或先运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\recover-codex.ps1 -Check` 只读检查），重启客户端连接后在原聊天调用 `futureaide_status({})` 与 `futureaide_list_agents({})` 即可无缝接回在途名单。

### 维护接口
`src/cli.mjs` 仍提供团队治理、黑板读写、反馈收件箱巡检（`feedback-pending`）与自动清理命令；早期显式会话 ID 维护接口默认隐藏，仅在维护环境显式设置 `FUTUREAIDE_LEGACY_TOOLS=1` 时启用，详见[旧版 CLI 与显式接口](skills/futureaide-control/references/legacy-workflows.md)。
