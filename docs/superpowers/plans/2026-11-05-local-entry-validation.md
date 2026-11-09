# 本地入口验证记录

日期：2026-11-05。范围：以官方 Runtime 为宿主替换消息入口；尚未接入 Paseo。

## 实际环境

- fork：`/Users/anxiaojie/src/superagent-with-paseo`，分支 `codex/paseo-integration`。
- 独立 DSH profile：`/Users/anxiaojie/.dsh/profiles/superagent-local-check`。
- 独立状态目录：`/Users/anxiaojie/.dsh/state/sa-local-check`。
- 本机入口：`local-ipc/s`；管理端口 3097。GitHub/飞书 watcher 插件均禁用。
- 复用现有 agent GitHub CLI 做官方 setup 的只读身份/仓库权限检查；没有改原 profile 或现有服务。
- 保留官方 Sessions、DshExecutor、主会话工具、worker 工具和提示词；真实模型自行路由和报告。

## 闭环结果

1. CLI 提交 `smoke-1`，线程 `smoke-thread`，请求先提问 A/B，再写结果。
2. 主会话调用原 `orchestrator_route` 接单，Ticket 为 `4fc2258f181f0b9df01e77d5a7a48d29`。
3. worker 用 `orchestrator_report` 报告问题，本地 Outbox 收到“使用 A 还是 B？”。
4. CLI 在同线程提交 `smoke-2`：“选择 A，请继续。”；输入回到该 Ticket。
5. worker 在其分配目录生成 `result.txt`，文件实际内容为 `local-smoke:A`，13 字节。
6. 原报告记录为 `ready`，Ticket 的 `ended.outcome` 为 `completed`；本地线程收到最终结果。
7. 停止并重启专用 profile 后，重复提交同一 `smoke-2` 返回 `duplicate`，任务数仍为 1，持久回复数仍为 4。
8. 实测发现 Channel 曾保存 Outbox 回执的发送前 `pending` 字段；修正为只保存 OutboundMessage 字段。更新构建后，新任务 `smoke-sanitized`（Ticket `03ba50f7fd6a64a3a560fe28b0305e59`）完成，结果文件为 `local-smoke:clean` 加换行，两条本地回复不再包含该字段。首次演练旧记录保留原样作为证据。
9. 验证进程已停止，专用 profile、数据库和产物保留用于复查。

测试没有推送代码、创建 PR 或通过 GitHub/飞书发消息。

## 自动检查

- `pnpm check`：类型检查、65 个测试文件 / 1246 项测试、构建全部通过。
- Runtime 测试包含真实 Unix socket、官方工具链和 Store/Effects/Outbox；模型服务为替身。上面的两次实测补充了真实模型证据。
- 覆盖入口默认关闭、Policy 允许名单、同 ID 内容冲突、事务回滚、回复顺序/去重、重启和启动期间关闭 socket。
- 一轮并行全量检查曾遇到既有 Feishu 子进程退出时序断言失败；单独复跑该文件 71 项通过，停止演示服务后再次全量检查通过。未修改该测试或对应实现。

## Paseo 对照验证（同任务流）

- 独立状态目录：`/Users/anxiaojie/.dsh/state/sa-paseo-check`，通过 `--patch /tmp/superagent-paseo-check.yml` 挂载到同一独立 profile（端口 3098），主协调者与 worker 均使用 `claude-pool/friday-deepseek-v4-flash`（mode `auto`）。
- 本机请求入口：`local-ipc/s`；agent 工具桥入口：`agent-ipc/s`（由 `bin/superagent-mcp.mjs` 通过 stdio MCP 暴露原 `orchestrator_*` 工具，按角色与 ticket/assignment 令牌绑定）。
- 闭环结果：
  1. CLI 提交 `paseo-smoke-1`（线程 `paseo-smoke-thread`）。
  2. Paseo 协调者 (`060b0ae7-ceff-4788-9593-fd470e0a47b8`) 调用 `orchestrator_route` 接单，创建 Ticket `09c5d5bd7dd3fc285b291db0d1e91e5c` 与 Assignment `41c815b64edb561cb758d58913db7a00`。
  3. Paseo worker (`1ba5ee88-3e3d-4890-b42c-c8adb5083b5b`) 调用 `orchestrator_report` 提问 A/B，回执落库并转发协调者，协调者调用 `orchestrator_reply` 将问题写入本地 Outbox。
  4. CLI 同线程提交 `paseo-smoke-2` 选择 A，输入投递至该 worker。
  5. worker 在 `/Users/anxiaojie/.dsh/state/sa-paseo-check/work/paseo-smoke-result-09c5d5bd7dd3/result.txt` 写入 `paseo-smoke:A`（13 字节），读取确认后调用 `orchestrator_report(state='ready')`；官方 Engine 将 Ticket 标记为 `completed`，协调者发送最终本地回复。
  6. 重启后再次提交 `paseo-smoke-2` 返回 `duplicate`，未新建会话或工单；`paseoStop` 完成中断请求与运行态快照落库（`request_sent: 1, observed_idle: 1, turn_stopped: 0, unknownChildren: true`），队列清空且検証进程已干净停止。

## 实际限制

- 本机入口只按 OS 账户限制访问；同账户下的程序在同一信任范围内。它不证明有人手动输入，也不是 worker 隔离机制。
- DSH setup 仍需要已配置的 GitHub 仓库和 agent CLI。
- Paseo 不提供 DSH 的静默历史注入、子进程静止证明或消息队列栅栏；后台通知随下一条正式协调者消息附带，停止观测如实保留 `turn_stopped: 0` 与 `unknownChildren: true`。

## Paseo transcript 补齐验证（2026-11-06，Asia/Shanghai）

- 接续未提交的 timeline 读取改动，补齐 Runtime 原 `ticket/<id>/transcript` 和 message 资源接线。正文、工具输入输出、错误及压缩标记投影为可读消息；省略 reasoning 与插件 UI 项。没有修改 Engine 或 ready 完成语义。
- 读取按页校验 epoch、reset、gap、cursor 和条目序号；历史不完整、冲突或超过 20 页时明确报错。消息链接由 agent ID、epoch 和 seqStart 绑定，流式增长不改变链接，旧链接不会指向新会话或重置后的其他内容。
- 只读实际 Paseo worker `1ba5ee88-3e3d-4890-b42c-c8adb5083b5b`：13 条公开 timeline 事件映射为 8 条消息，其中 5 条工具调用；可读取 `paseo-smoke:A` 的写入、Read 验证和 ready 报告，重复读取一致。没有创建新模型任务。
- `pnpm check` 通过：66 个文件、1255 项测试，类型检查与构建通过。真实 Runtime/工具桥测试覆盖 coordinator 和 worker 读取、不可用历史、错误消息 ID 及重启后读取。
- 构建后使用已保存的 `/Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml` 启动独立环境，CLI status 返回 configured=true、paused=false、accepting=true。经实际 agent IPC 工具桥调用 `orchestrator_read`，原 ticket transcript 返回 8 条记录；最新消息详情包含结果文件内容，两次独立请求一致，effect 表为空。
- 验证进程随后通过 SIGINT 退出（退出码 130）；状态和成果保留。配置从 `/tmp` 移到 profile 下的独立覆盖文件，DSH 基线配置不变。启动、提交、回复、停止命令见 [本地使用指南](../../local-usage.md)。
