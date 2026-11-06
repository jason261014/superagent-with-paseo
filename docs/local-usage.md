# 本地 Paseo 使用指南

当前版本沿用官方 DSH 宿主和任务状态机，通过本地 CLI 收发请求，由 Paseo 执行协调者和 worker。代码目录是 `/Users/anxiaojie/src/superagent-with-paseo`。

## 已准备的本机配置

- DSH profile：`superagent-local-check`，已链接这个 fork。
- Paseo 启动覆盖配置：`/Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml`。
- 独立状态目录：`/Users/anxiaojie/.dsh/state/sa-paseo-check`。
- 管理地址：`http://127.0.0.1:3098`。
- Paseo daemon：`ws://127.0.0.1:6767/ws`。
- 协调者与 worker：`claude-pool/friday-deepseek-v4-flash`，mode `auto`。
- 本地请求已允许当前 OS 用户；GitHub 与飞书 watcher 插件关闭。

这是已完成演练的环境，会保留先前任务和回复。DSH 官方 setup 仍依赖该环境已有的 GitHub repository 和 agent CLI 配置。切换模型需要修改覆盖配置并重启；已存在的 Paseo 会话仍使用创建时的模型配置。

## 启动

在一个终端前台运行；确认 Paseo daemon 已经运行（`paseo status --json`），再执行：

```sh
cd /Users/anxiaojie/src/superagent-with-paseo
pnpm build
dsh --profile superagent-local-check \
  --patch /Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml \
  --no-open
```

保留这个终端。在另一个终端检查入口状态：

```sh
node /Users/anxiaojie/src/superagent-with-paseo/bin/superagent-local.mjs \
  --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check status
```

`configured: true`、`paused: false`、`accepting: true` 表示宿主配置完成、执行未暂停且本地 Source 开放；实际任务仍经 Policy 判断。管理面板可查看工单和问题。若等待 setup，查看面板的具体缺项。

## 提交任务与继续对话

用新的请求 ID 提交一次任务；每段对话固定一个 thread ID。例如先做一个仅写任务目录的验证：

```sh
node /Users/anxiaojie/src/superagent-with-paseo/bin/superagent-local.mjs \
  --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check submit \
  --request-id local-demo-1 --thread-id local-demo \
  --text '请先询问我选择 A 还是 B，收到答复后在任务目录创建 result.txt，写入选项并读取验证，然后报告结果。'
```

查看已保存回复：

```sh
node /Users/anxiaojie/src/superagent-with-paseo/bin/superagent-local.mjs \
  --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check replies --thread-id local-demo
```

收到提问后，在相同线程提交新请求 ID：

```sh
node /Users/anxiaojie/src/superagent-with-paseo/bin/superagent-local.mjs \
  --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check submit \
  --request-id local-demo-2 --thread-id local-demo --text '选择 A，请继续。'
```

`stored` 只表示收到请求；接单、提问和最终结果从 `replies` 读取。请求结果不确定时，重试同一个 request ID、thread ID 和原文；重复提交返回 `duplicate`，改正文复用旧 ID 会报冲突。每次重新做演示应换一组 ID。

当前 CLI 只提供 `status`、`submit`、`replies`，回复命令读取当前快照。任务目录和结果位置由任务回复给出；模型通过 `orchestrator_read` 的 `ticket/<id>/transcript` 查看 Paseo 执行消息与工具证据，详情使用返回的 `read` 链接。Paseo 自身的会话时间线也可查看原始执行过程。直接在 Paseo 窗口发送消息尚未接入本地请求的 Policy/幂等流程。

## 停止与恢复

在启动终端按 Ctrl-C，等待 DSH 完成退出。状态、任务目录和回复保留；下次执行相同启动命令恢复。宿主会对它绑定的活跃 Paseo 会话尝试中断，但 Paseo 的 idle 观测不能证明所有后台子进程已停止，停止记录会保留这项未知。

官方 `scripts/dsh-superagent` 默认控制另一个 profile，且不接收这里的覆盖配置；本指南使用上面的显式前台命令。不要同时启动同一 profile 的 DSH 基线模式和 Paseo 模式。
