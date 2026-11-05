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

## 实际限制

- 本机入口只按 OS 账户限制访问；同账户下的程序在同一信任范围内。它不证明有人手动输入，也不是 worker 隔离机制。
- DSH setup 仍需要已配置的 GitHub 仓库和 agent CLI。
- Paseo 协调者、执行者、报告桥、中断和恢复尚未完成接线或实测。
