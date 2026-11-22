# 子代理自动清理

管理员使用插件安装目录里的 `node src/cli.mjs cleanup`。所有子命令都接受 `--config <基础配置文件>` 和可选的 `--profile <档案名>`。预览可以在总开关关闭时使用。

1. `cleanup preview --output snapshot.json` 生成只读清单。默认盘点名单、DSH 根和文件，限定一项可用 `--scopes roster`、`dsh` 或 `files`。输出文件必须是新文件。看 `coverage` 是否完整，再查看 `summary`、逐项的 `reason`、稳定 `key` 和包含的 `memberKeys`。共享附件释放量为零。需要保护某一个下属时复制其完整 memberKey。
2. 将选择写入单独的 UTF-8 JSON 文件。`snapshot` 填预览的 hash，`first` 填首批立即处理的完整 key 列表，`keep` 填明确保留的 key，`keepKinds` 列出本次快照中要保留的类别。`remaining` 的 `B` 允许剩余对象日后满足规则时清理，`hold` 表示继续保留。五棵带修改的开发树、所有在办项目和并行插话包的树均需看单项说明。当前命令只处理干净且已合入的开发树。
3. `cleanup approve --manifest snapshot.json --decisions decisions.json` 登记选择，保存返回的 approval 摘要。启用前如有对象增减，重做预览和签认。已经启用的授权账只接受已登记的批准。跨目录共用 DSH 根时，一个物理根只归签认的档案负责；原账丢失或归属不符可在 status 看到。
4. 在获准的目标档案设置 `agentAutoCleanup` 为 true，然后执行 `cleanup enable`。周期由 `agentCleanupIntervalMs` 控制，总开关默认关；`onceTerminalRetentionMs` 默认 24 小时，`agentIdleRetentionMs` 12 小时，`diagnosticRetentionMs` 7 天。`codexAutoCleanup:false` 将 Codex 线程排除出按规则清理，已批准的首批可以单独执行。原有成功送达 final 的 once 仍即时收尾。
5. `cleanup apply --manifest snapshot.json --approval <摘要> --output result.json` 执行首批，只复核身份、活动、运行和树，遇变化返回原因。开发树另加 `--worktree-review <文件>`，文件按对象 id 索引，含本次 `activityVersion`、`confirmedUnused`、`evidencePreserved` 和 `copies`（每个忽略文件相对路径对应树外路径 path 与 sha256）。先迁出证据、核散列并更新引用。执行中逐树重读该审签文件、项目资料和实际名单，Git 仅移除工作树，保留分支。
6. `cleanup status` 可查账 ID、负责配置、代次、监工确认和近期操作。`cleanup disable` 阻止继续领取，已提交动作按回执核对。配置文件手工关掉总开关也会使监工停用授权。逐项撤销明确保留用 `cleanup revoke --key <完整key>`。DSH 若返回 staged，则暂存占用仍在，默认宽限 24 小时，可在桥配置中设置 `cleanupGraceMs`。宽限内可用 `cleanup restore --ticket <票号>`。成功恢复后保留，撤销保留后重新参与规则。监工对已提交的首批暂存票按原授权复核收尾。
7. `cleanup archive --name <名字> --owner <ownerId> --from <UTC> --to <UTC> --output archive.json` 导出归档。支持 `--agent-id` 和 `--original-id <原问题或回报ID>`，输出保留原文。申请离线收缩须在同一 decisions 内明确写入 `vacuum`，包括 selected、database（名单库绝对路径）、minimumBytes、maxPauseMs、measuredVacuumMs。停写后用 `cleanup vacuum --decisions decisions.json --approval <摘要> --output <树外新备份的绝对路径>` 执行。工具先做一致备份并校验，实际收益或时间预算不满足就跳过，返回主库字节差和 WAL 大小。

选择文件示例（占位字符串要替换为本次清单值）：

```json
{
  "snapshot": "本次清单的 hash",
  "first": [],
  "keep": [],
  "keepKinds": [],
  "remaining": "B"
}
```

部署、存量清单签认、启用及实际执行按各自批准范围办理。
