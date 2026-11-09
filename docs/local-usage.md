# 本地 Paseo 使用指南

当前版本沿用官方 Superagent 任务状态机：一个 Paseo 插件按项目管理独立 Runtime 子进程，通过 `superagent` provider 对话，协调者和 worker 均在 Paseo 执行。代码目录是 `/Users/anxiaojie/src/superagent-with-paseo`。

## 多项目日常使用

现在本机使用 `managed` 模式。现有实例登记为 `legacy`（显示名 oss-explore），对应原配置仓库 `jason261014/oss-explore`，项目根为 `/Users/anxiaojie/src/oss-explore`。原状态仍是 `/Users/anxiaojie/.dsh/state/sa-paseo-check`，没有迁移数据库或重建原会话。管理目录是 `/Users/anxiaojie/.dsh/state/superagent-manager`。

原 Superagent 对话可以继续使用。新建对话时直接选择 **Superagent**：首次使用的 cwd 会自动登记为独立项目，并写入 `<managerDir>/projects.json`；对话随后持久绑定稳定 projectId，切换窗口或目录不会把旧会话转给其他项目。自动登记只继承项目的运行参数（模型、桥接路径等），不复制 GitHub 账号、Policy、Ticket 或数据库。不同 clone 和 worktree 默认按各自路径登记，不自动合并。

```sh
cd /Users/anxiaojie/src/superagent-with-paseo
node bin/superagent-project.mjs --manager-dir /Users/anxiaojie/.dsh/state/superagent-manager list
node bin/superagent-project.mjs --manager-dir /Users/anxiaojie/.dsh/state/superagent-manager status legacy
node bin/superagent-project.mjs --manager-dir /Users/anxiaojie/.dsh/state/superagent-manager stop legacy
node bin/superagent-project.mjs --manager-dir /Users/anxiaojie/.dsh/state/superagent-manager start legacy
```

`start`/`restart` 返回 accepted 只代表运行操作已接受；等 host.phase=ready 后再恢复对话。Provider 首次打开最多等待 20 秒；仍超过时返回 `PROJECT_STARTING`，后台继续启动，确认 ready 后 reload/reopen 原对话。已经有接收记录的输入不要换 ID 重发。

首次使用项目时按需启动，首版没有自动空闲回收。关闭对话不会停止项目；手动 stop 后，打开对话也不会自动撤销停止，必须显式 start。插件/daemon 重启会恢复此前运行的项目，手动停止和从未使用的项目保持停止。单个项目的启动错误不停止其他已运行项目。

Paseo 桌面窗口与 daemon 是不同生命周期。daemon 在线时可继续执行；Paseo v0.15.3 的 `keepRunningAfterQuit` 控制退出桌面后是否停止它托管的 daemon，默认 false。我们没有修改该设置。daemon 真正停止时，插件并行停止项目并保留恢复状态；这不保证任意外部操作或未知后台进程都能被中断，也不把 Ticket 标记为完成。

### 新项目自动登记

用户不需要编辑 `local-config.ts`。首次在新 workspace 发起 Superagent 对话时，管理器会生成 `auto-<目录名>-<路径哈希>` 形式的稳定 id，在 `projectStateRoot`（默认是 managerDir 同级的 `superagent-projects/<id>`）创建独立 stateDir，并把项目定义持久化到 `<managerDir>/projects.json`。后续消息、重载插件和 daemon 重启都按该 projectId 恢复；同一 workspace 的子目录复用同一个项目。新项目默认不启用 flow-web，避免端口冲突。

`local-config.ts` 的静态 `managerConfig.projects` 仍是高级覆盖入口，用于固定 id、aliases、指定 stateDir 或提前禁用项目；示例见 [多项目配置](../paseo-plugin/shared/projects-config.example.ts)。设置 `autoRegister: false` 可恢复“只接受显式登记”的行为。root 与 stateDir 必须存在且属于当前用户；Node、childEntry、runtimeEntry 和 MCP 路径必须是绝对路径。managed 模式不能同时使用全局 `SUPERAGENT_STATE_DIR`。

登记不会复制另一个项目的账号、Policy 或工具授权。新状态默认走 workspace-first 本地模式：没有 GitHub repository 也能启动协调者、接 Paseo 消息并在 workspace 内执行；GitHub skill 和 `gh` 会明确不可用，涉及 PR/Issue 的能力需要之后再配置 GitHub。不要复制带会话身份和任务的现有数据库来创建第二个项目。

### 本地模式与 GitHub 模式

项目 stateDir 首次启动时，如果没有配置 `sources.github.repository`，Runtime 使用本地身份 `local <local@localhost>`，并自动启用当前 OS 用户的 local source（`acceptRequests: true` 和 `uid:<uid>` 允许名单）。如果项目根是 Git 仓库，新 Ticket 的 prepare 默认用 `git worktree add --detach "$DSH_SUPERAGENT_DIR" HEAD` 建隔离工作区；非 Git 目录仍可对话，但没有自动工作区。

在设置里配置 GitHub repository 和 agent CLI 后，下一次启动会恢复 GitHub 校验、GitHub skill、`gh` 凭据和 PR 能力。GitHub 配置存在但 CLI/账号不可用时仍会停在 needs_setup，不会静默退回本地模式。

项目画布仍由该项目 Runtime 管理；现有项目保留端口 17890。新项目默认不启用，启用时使用不同的非零端口，或 port=0 让 OS 分配。实际 URL 从 project status 读取。各项目日志位于 `<managerDir>/logs/<id>.log`，当前文件最多 1MiB 并保留一份轮转。

### 多项目模式回滚

先 disable 插件，确认所有项目子进程和状态锁释放，再恢复原 external/embedded 配置并 enable。不要同时运行两种宿主，也不要用旧备份覆盖新任务。单实例模式可读取同一 binding 的 v2 历史，事件仍使用单实例的 v1 格式；Paseo 只重载历史时可能保留已有 v2 存储。回到 managed 后同时支持 v2 项目绑定和经 legacyProjectId 精确校验的 v1 历史，其他项目绑定不会被接受。

完整证据和验证范围见 [多项目验收记录](superpowers/plans/2026-11-09-paseo-multi-project-runtime-validation.md)。

## 已准备的本机配置

- Paseo 插件：`superagent`，配置在 `paseo-plugin/shared/local-config.ts`。
- 兼容/回滚用 DSH profile：`superagent-local-check`，已链接这个 fork。
- Paseo 启动覆盖配置：`/Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml`。
- 独立状态目录：`/Users/anxiaojie/.dsh/state/sa-paseo-check`。
- `managed`/`embedded` 模式没有 DSH 管理面板；`http://127.0.0.1:3098` 只在旧 DSH 宿主运行时可用。
- Paseo daemon：`ws://127.0.0.1:6767/ws`。
- 协调者与 worker：`claude-pool/friday-deepseek-v4-flash`，mode `auto`。
- 本地请求已允许当前 OS 用户；GitHub 与飞书 watcher 插件关闭。

这是已完成演练的环境，会保留先前任务和回复。DSH 官方 setup 仍依赖该环境已有的 GitHub repository 和 agent CLI 配置。managed 模式的模型配置在对应 projects 项的 hostConfig.paseo；embedded 在顶层 hostConfig.paseo。修改后重载插件；已存在的 Paseo 会话仍使用创建时的冻结配置。

## 安装或重载 Paseo provider

`paseo-plugin/` 是本地插件目录，`paseo-plugin/server/provider.mjs` 由构建生成，不能跳过构建。首次使用或源码更新后执行：

```sh
cd /Users/anxiaojie/src/superagent-with-paseo
pnpm build
paseo daemon config set pluginsEnabled true
paseo plugin install /Users/anxiaojie/src/superagent-with-paseo/paseo-plugin \
  --host 127.0.0.1:6767
paseo plugin reload superagent --host 127.0.0.1:6767
paseo plugin ls --host 127.0.0.1:6767
```

如果 `superagent` 已经安装，重复安装会被 Paseo 拒绝或提示已存在，此时只需重新执行 `pnpm build` 和 `paseo plugin reload`。managed 模式按项目配置 stateDir；只有旧单实例模式使用 `~/.dsh/state/sa-paseo-check` 默认值或 SUPERAGENT_STATE_DIR 覆盖。不要为了改项目状态目录重启整台日常 daemon。

## 单实例兼容使用（embedded 模式）

Paseo daemon 运行时，插件在后台启动控制面。打开原来的 **Superagent** 对话直接发消息即可，无需启动 DSH 终端。

```sh
paseo plugin ls --host 127.0.0.1:6767
paseo plugin logs superagent --host 127.0.0.1:6767
node /Users/anxiaojie/src/superagent-with-paseo/bin/superagent-local.mjs \
  --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check status
```

`configured: true`、`paused: false`、`accepting: true` 表示入口可用；实际接单仍经 Policy 判断。插件显示 running 只表示 provider 已注册，后台可能仍在启动或等待配置，应用状态以 local status 和对话中的提示为准。

关闭一个对话窗口不会停止全局任务。disable/reload 插件会停止或重启控制面；正常重载沿用数据库、会话绑定和待确认消息。异常退出可能需要约 30 秒等待旧目录锁过期；不得手动删除活锁。停止等待超时不代表底层任务已停。

如果插件异常退出后，原对话仍显示插件进程错误，先重载插件，再重新打开或 reload 原对话。实测这样可以恢复历史和已完成任务的结果，无需另建对话或重发任务。详细记录见 [宿主迁移验证](superpowers/plans/2026-11-08-paseo-plugin-host-validation.md)。

## 宿主配置与回滚

`paseo-plugin/shared/local-config.ts` 提供 `hostMode`（`embedded`/`external`）、`runtimeEntry` 和 `hostConfig`。`embedded` 必须指定绝对路径的 `lib/paseo-host.js`、Node 可执行文件及 MCP 入口，且 provider 与 host 的 stateDir 必须一致；`SUPERAGENT_STATE_DIR` 会同时覆盖两端。示例见 `paseo-plugin/shared/local-config.example.ts`。

不要同时启动两个宿主。回滚顺序：先 disable 插件，确认原进程退出且状态目录锁释放；将 hostMode 改回 external；再启动下面的 DSH profile，最后 enable 插件。继续使用原数据库，不以旧备份覆盖迁移后产生的数据。

```sh
paseo plugin disable superagent --host 127.0.0.1:6767
# 修改 local-config.ts 的 hostMode 为 external，并确认旧锁已释放。
dsh --profile superagent-local-check \
  --patch /Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml \
  --no-open
# 在另一个终端恢复 provider：
paseo plugin enable superagent --host 127.0.0.1:6767
```

## 提交任务与继续对话

### Paseo 原生窗口

在 Paseo 新建 agent/session 时，把 provider 选择为 **Superagent**，然后直接发送普通文本。第一次消息会按现有 Local Source、Policy 和 coordinator 流程创建或等待接单；协调者的确认、追问和结果会回到同一个 Paseo 窗口。收到追问后，继续在同一个窗口回复即可；新的一轮独立任务仍使用新的 request 身份，不会自动串到旧 Ticket。

每个 Ticket 的 worker 会作为 orchestrator 的 delegated agent 出现在同一个 Paseo workspace 中。worker 进程的初始目录是 orchestrator 的 workspace 目录，Ticket 自己的执行目录通过 `DSH_SUPERAGENT_DIR` 传入；worker 指令要求它在执行任何命令前先 `cd "$DSH_SUPERAGENT_DIR"`。

### 异步状态

Paseo 对话时间线会把 Superagent 的后台进度显示为 notification 项，而不是 assistant 文本：请求已提交、Ticket 已创建、Worker 已启动、执行中摘要、等待补充、受阻/失败、完成和 Ticket 结束。状态事件与 user/assistant 事件一起持久化在项目数据库的 conversation event 中，重开对话、插件重载或 daemon 重启后可以恢复；它们不会替代协调者的确认、追问和最终结果。

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

managed 模式优先使用前面的项目 CLI 停启单个项目；disable/enable/reload 插件影响全部项目。embedded 单实例通过 `paseo plugin disable superagent --host 127.0.0.1:6767` 停止，通过 enable 恢复；只想重启则用 reload。关闭聊天窗口不会停止宿主。

仅在 external 回滚模式下，才在 DSH 启动终端按 Ctrl-C，等待退出，下次使用相同命令恢复。两种模式都会保留状态、任务目录和回复。宿主会对它绑定的活跃 Paseo 会话尝试中断，但 Paseo 的 idle 观测不能证明所有后台子进程已停止，停止记录会保留这项未知。

官方 `scripts/dsh-superagent` 默认控制另一个 profile，且不接收这里的覆盖配置；本指南使用上面的显式前台命令。不要同时启动同一 profile 的 DSH 基线模式和 Paseo 模式。


## 只读流转画布

需要查看一条请求从 Superagent 入口到 Orchestrator、Worker 和回复出口的流转时，在 `paseo-plugin/shared/local-config.ts` 的 `hostConfig` 加入：

```ts
flowWeb: { enabled: true, port: 17890 },
```

重新 `pnpm build` 并 `paseo plugin reload superagent` 后，宿主会在 `127.0.0.1:17890` 启动只读服务。访问令牌和完整链接写在 `<stateDir>/flow-web/access.json`（权限 `0600`），把其中 `url` 加上 `#token=<token>` 在浏览器打开即可。

画布只读：不能派工、重试、取消、改 Policy 或发送消息；打开/关闭页面不会启停控制面。它直接读取现有 SQLite 记录，不发起 LLM 调用。首次查看历史汇报时，无接收时间戳的记录会显示“timestamp not recorded”；未确认的 create/send 意图显示 `unconfirmed`。`sent` 只表示回复已进入发送出口，不表示用户已读。旧 Assignment 的实时 transcript 无法回查，只按已确认的 create 记录还原其 Worker `agentId`。
