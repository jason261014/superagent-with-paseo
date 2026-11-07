# 本地 Paseo 使用指南

当前版本沿用官方 DSH 宿主和任务状态机，通过 Paseo 原生 `superagent` provider 直接对话，由 DSH 的协调者和 Paseo worker 执行任务。代码目录是 `/Users/anxiaojie/src/superagent-with-paseo`。

## 已准备的本机配置

- DSH profile：`superagent-local-check`，已链接这个 fork。
- Paseo 启动覆盖配置：`/Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml`。
- 独立状态目录：`/Users/anxiaojie/.dsh/state/sa-paseo-check`。
- 管理地址：`http://127.0.0.1:3098`。
- Paseo daemon：`ws://127.0.0.1:6767/ws`。
- 协调者与 worker：`claude-pool/friday-deepseek-v4-flash`，mode `auto`。
- 本地请求已允许当前 OS 用户；GitHub 与飞书 watcher 插件关闭。

这是已完成演练的环境，会保留先前任务和回复。DSH 官方 setup 仍依赖该环境已有的 GitHub repository 和 agent CLI 配置。切换模型需要修改覆盖配置并重启；已存在的 Paseo 会话仍使用创建时的模型配置。

## 安装或重载 Paseo provider

`paseo-plugin/` 是本地插件目录，`paseo-plugin/server/provider.mjs` 由构建生成，不能跳过构建。首次使用或源码更新后执行：

```sh
cd /Users/anxiaojie/src/superagent-with-paseo
pnpm build
paseo plugin install /Users/anxiaojie/src/superagent-with-paseo/paseo-plugin \
  --host 127.0.0.1:6767
paseo plugin reload superagent --host 127.0.0.1:6767
paseo plugin ls --host 127.0.0.1:6767
```

如果 `superagent` 已经安装，重复安装会被 Paseo 拒绝或提示已存在，此时只需重新执行 `pnpm build` 和 `paseo plugin reload`。插件默认读取 `~/.dsh/state/sa-paseo-check`，必须与 DSH profile 的 `dsh-superagent.stateDir` 相同；若使用其他目录，在启动 Paseo daemon 的环境中设置 `SUPERAGENT_STATE_DIR`，或修改 `paseo-plugin/shared/local-config.ts` 后重载插件。改环境变量后要重启 daemon 才能让插件进程继承新值。

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

### Paseo 原生窗口

在 Paseo 新建 agent/session 时，把 provider 选择为 **Superagent**，然后直接发送普通文本。第一次消息会按现有 Local Source、Policy 和 coordinator 流程创建或等待接单；协调者的确认、追问和结果会回到同一个 Paseo 窗口。收到追问后，继续在同一个窗口回复即可；新的一轮独立任务仍使用新的 request 身份，不会自动串到旧 Ticket。

Paseo provider 目前只接受纯文本消息。图片、文件、结构化 output schema 和其他输入类型会被拒绝。Paseo 窗口的中断按钮只中断当前前台输入等待；已经被宿主接收的 Ticket 仍会继续执行。要停止已接收的 Ticket，请在同一窗口发送明确的停止请求，让协调者按原有工具流程处理。

命令行也可以验证 provider 是否可用：

```sh
paseo provider ls --host 127.0.0.1:6767
paseo run --provider superagent --no-wait \
  --title superagent-demo \
  '请先询问我选择 A 还是 B，收到答复后在任务目录创建 result.txt。' \
  --host 127.0.0.1:6767
```

图形窗口更适合持续对话；`paseo send <agent-id> '<text>'` 可作为命令行续问方式。

### 本地 CLI 入口

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

当前 CLI 只提供 `status`、`submit`、`replies`，回复命令读取当前快照。任务目录和结果位置由任务回复给出；模型通过 `orchestrator_read` 的 `ticket/<id>/transcript` 查看 Paseo 执行消息与工具证据，详情使用返回的 `read` 链接。Paseo provider 使用同一套本地请求幂等记录和 Policy，重连时会按事件游标恢复历史，不会重复显示已经发出的消息。

## 停止与恢复

在启动终端按 Ctrl-C，等待 DSH 完成退出。状态、任务目录和回复保留；下次执行相同启动命令恢复。宿主会对它绑定的活跃 Paseo 会话尝试中断，但 Paseo 的 idle 观测不能证明所有后台子进程已停止，停止记录会保留这项未知。

官方 `scripts/dsh-superagent` 默认控制另一个 profile，且不接收这里的覆盖配置；本指南使用上面的显式前台命令。不要同时启动同一 profile 的 DSH 基线模式和 Paseo 模式。
