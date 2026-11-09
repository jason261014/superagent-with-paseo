# 项目导读（深挖版）：dsh-superagent / superagent-with-paseo

本文回答三个问题：**这个项目做什么**、**各模块之间怎么协作**、**怎么把它跑起来**。
与上一版导读相比，本文以源码为准，逐个调用链核对过（分支 `codex/paseo-integration`，含未提交改动），
并补充了状态机、单一写入者、幂等与恢复这些“改代码前必须知道”的细节。
规范性的定义仍以 `docs/000`–`docs/008` 为准；本文是索引加串讲，不替代它们。

---

## 1. 一句话与边界

**它是一个“面向单个 GitHub 仓库的主动式编码代理”**。上游以 DeepSeek Harness（DSH）bundle 形式发布，本 fork 还可由 Paseo 插件直接托管：
监听 GitHub（可选飞书、可选本机）上的消息 → 用 Policy 判断“谁、以多大权限、能不能发起工作” → 立项成 Ticket →
在独立会话与独立目录里执行 → 回到原对话交付（通常是 PR）。DSH 模式保留 Web 面板，Paseo 模式通过对话、日志和本地 CLI 查看状态。

`package.json` 的名称是 `dsh-superagent`（v0.1.0，MIT，private），本仓库是它的 fork，分支
`codex/paseo-integration`。本地宿主改造及验证记录保留在当前工作树，尚未推送。

**它不是什么**（README 与 `docs/000` 明确写着）：

- 不是生产系统，是研究原型；风格与工程质量有意保留“实验代码”的痕迹。
- 不是通用聊天机器人：它默认**只在一个仓库**里工作，且**只在被明确请求、或团队写下的规则允许时**行动。
- 不是多租户服务：状态目录单进程独占（目录锁），本地 IPC 只代表“同一个 OS 账号”，不是认证边界。

## 2. 两种宿主，同一套内核

2026-11-08 增加 Paseo 插件宿主：公共 Runtime 接收宿主接口，Engine、Policy、Ticket、Assignment、Effects、Outbox 与 SQLite 继续复用。模型调用仍由 Paseo 的 orchestrator/worker 执行。

| | DSH 兼容路径 | Paseo embedded 路径 |
| --- | --- | --- |
| 宿主入口 | `src/hosts/dsh.ts`，由 Cordis 注册 | `src/hosts/paseo.ts` → `lib/paseo-host.js` |
| 生命周期 | DSH profile | 一个 Paseo 插件实例拥有一个 Runtime |
| 执行后端 | 原生 DSH，或现有 Paseo adapter | 现有 Paseo adapter |
| 配置 | DSH patch | 插件 local-config.ts 的 hostConfig |
| 管理面板 | 原 DSH 面板 | 暂不提供替代面板；使用日志、CLI 和对话 |

`src/paseo/backend.ts` 负责原有 Paseo sessions/executor/bridge/reports 的接线。`src/paseo-ui/host-control.ts` 仅处理插件加载与停止，不管理第二套业务状态。

```text
Paseo daemon
  └─ superagent 插件进程
       ├─ provider → local-ipc/s → Runtime / Engine / Store
       └─ agent-ipc/s ← MCP stdio ← Paseo orchestrator / workers
```

2026-11-09 增加 managed 模式：一个插件管理器按 cwd/持久 projectId 路由，每个登记项目独立 Runtime 子进程，原单实例 embedded/external 仍兼容。项目登记、运行意图和 CLI 位于 `src/projects/`；provider 的项目封装位于 `src/paseo-ui/project-router.ts`。当前 legacy 项目保留原 stateDir、会话和 worker 绑定，首版按需启动、显式停止，不做自动空闲回收。

关闭窗口只关闭 provider 连接；disable/reload 插件影响全部已启动项目。退出预算用完不会提前关库或释放锁；进程意外终止后等待旧锁过期，再按持久化 journal/回执恢复。daemon 重启恢复运行意图，手动停止项目不被普通对话自动唤醒。桌面退出是否停止 daemon 则遵守 Paseo 自身设置。

两个 socket 都是 `0700` 目录 + `0600` socket，路径上限 103 字节（macOS）。**操作者 socket 不是 worker 报告通道**；
worker 只能通过 `agent-ipc` 上被 token 绑定的 MCP 桥说话（`src/paseo/mcp.ts` → `src/paseo/bridge.ts`）。

## 3. 一条请求的完整生命周期

下面按“本机 Paseo 形态”走一遍，其它入口只在第 2 步不同。

### 3.1 进入（Source → Trigger）

1. Paseo 窗口发纯文本 → provider `session.prompt`（只接受 `delivery: 'auto'`、纯 text parts）
   → `ConversationInput`（`src/local/protocol.ts`）落盘到 `paseo-ui-pending/`（崩溃后可对账）。
2. `POST /paseo/requests` → `LocalConversation.receive`（`src/local/conversation.ts:33`）**一个事务里**做三件事：
   写 receipt、分配会话事件序号、把 trigger 映射到会话；再调用 `createLocalSource.receive`。
3. `localTrigger`（`src/sources/local.ts:51`）把请求变成领域 `Trigger`：
   `actor = uid:<getuid()>`、`human: true`、`addressed: 'direct'`、thread key 由 requestId 派生。
   请求体**不能自带身份**；同 requestId 改正文会 `LOCAL_REQUEST_CONFLICT`。
4. `Passes.receive`（`src/app/passes.ts:34`）→ `Engine.receive` → `Intake.receive`（`src/core/intake.ts:19`）：
   - 去重（同 id 直接 `duplicate`）；
   - `SourceRegistry.scope()` 做来源级过滤（Local Source 关闭时 socket 层直接 409；若配置中途变化，这里记 `filtered`）；
   - 落库 trigger、更新 thread（`lastAt`、相互 `correlated`）、**扇出**给该 thread 的订阅 Ticket；
   - 写 `TriggerDisposition`（`fanout` / `context`）；
   - 若 `followupOwners()` 为空（没有仍能决定这条消息的 Ticket），排入 Eval 队列。

> 三种来源的差别几乎都在“闸门”里：GitHub 是“通知 + 可选观察 Issue/PR/评论/CI”，飞书是“事件 + 历史 + 话题”，
> Local 是“同 UID + 显式 submit”。`scope()` 返回 `listened/observed/row`，后面的准入表按 `row`（接收范围）取格子。

### 3.2 研判（Eval → Decision）

5. 每 2 秒一次 `Passes` 定时器（或收到消息立即）→ `Engine.evaluateDue` → `Evals.start`（`src/core/evals.ts:71`）：
   把该 thread 排队的 trigger 合成一个批次，逐条过 `policy.gate`，取“最强 + 最新”的那条作为
   `strength` / `actor` / `basis`，写入 `thread.evaluating`（含 deadline），并 `assessor.request()`。
6. `assessment` effect → `MasterAssessor`（`src/app/assessment.ts:98`）把候选卡投递给主 Session
   （requestId = `candidate:<evalId>`），**送达之后**才 `candidateDelivered` 开始计超时。
   超时（默认 120s，可配）会重排队最多 2 次，之后记 `unavailable`（`Evals.expire`）。
7. 主 Session 的模型用工具做决定：
   - `orchestrator_eval` / `orchestrator_eval_read`：有界读上下文（窗口、文件、图片）；
   - `orchestrator_eval_decide`：主动候选的 accept/ignore/unavailable（要逐条评估每个启用规则 + `direction`）；
   - `orchestrator_route`：批量路由（`accept` / `attach` / `stop` / `ignore`），**显式请求走这里而不是 assessment**。
8. `Evals.decide`（`src/core/evals.ts:131`）落 Decision：
   - `accept` → `Tickets.create`（同一事务）；
   - `stop` → 结束指定 Ticket（只有显式强度的消息能停）；
   - `ignore` / `unavailable` → 只记录，`unavailable` 可在面板 dismiss。

### 3.3 立项与执行（Ticket → Assignment → Worker）

9. `Tickets.create`（`src/core/tickets.ts:37`）：
   - 生成 `Mandate`（不可变：strength、policyVersion、basis、actor、scope）；
   - 收集来源 Channel；`prepareTicket` → `ticketExecution` 生成短名 `<worktree-name>-<ticketId 前 12 位>`
     与目录 `<executionRoot>/<短名>`（默认 root = `<stateDir>/work`）；
   - 压入第一个 `Assignment`（`pending`），订阅所有来源 thread；
   - 若 accept 带了 `acknowledgement`，经 `Replies` 立即排队一条确认回复；
   - `executor.start()` 只是**入队** `launch`（DSH）或 `paseoLaunch`（Paseo）effect，不直接做网络/进程操作。
10. Effect 在**事务提交之后**执行（`src/app/effects.ts`）：可配并发上限、指数退避、`Later` 表示“现在不能跑，稍后再来”。
11. DSH 执行器 `DshExecutor.launch`（`src/executor/dsh.ts:427`）：
    准备目录（`prepare` 命令，10 分钟超时）→ `sessions.ensure('worker-<ticketId>')` → 用 requestId
    `assignment:<ticketId>` 投递“任务书”（ticket id、title、assignment 文本、源 trigger、批次）→ `assignmentStarted`。
    Paseo 执行器同构，但先创建 Paseo agent，再把等价的任务书（JSON 形式）作为首条消息发送（见 §6）。
12. Worker 会话只有受限工具集：`orchestrator_read`、`orchestrator_ack`、`orchestrator_report`、
    `orchestrator_thread_follow/unrelated`、`orchestrator_trigger_handback`（`src/app/tools/executor.ts`）。
    它**不能**自己立项、改 Policy、发任意消息。
13. 报告链：`orchestrator_report` → `Engine.reportForAssignment`（检查“必须是当前 running assignment”）
    → `Assignments.report`（`src/core/assignments.ts:99`）：
    - 更新 `assignment.report`、`ticket.attention`（问题）、`ticket.answers`；
    - `blocked`/`failed` 会**扣住**自动输入（CI、机器人），直到人来消息；
    - `ready` → 无 followed thread 时 `completed` 结束；有 PR 时等 `followsDone`；
    - `dropped` → 结束，不发消息（除非匹配规则要求）。
    同时生成 relay 注入主 Session（`src/app/notices.ts`）：`progress` 且无 answer 的不打扰人。

### 3.4 交付（Reply → Outbox → Channel）

14. 主 Session 的 `orchestrator_reply`（purpose：`answer` / `result` / `attention`）或 worker 的
    `orchestrator_ack` → `Replies`（`src/core/replies.ts`）按“用途规则 + 幂等 id”入 Outbox：
    - `acknowledgement` 必须回原消息所在的 Channel 且发送者是人；
    - `result` 只允许 `ready` / `completed` / `merged` / `dropped` 的 Ticket；
    - `attention` 必须与 `ticket.attention.question` 完全一致。
15. `Outbox.send` 写 `outbox` 回执（`pending`）并入队 `reply` effect；投递时：
    - Source 关闭 → `Later`；同 Ticket 同会话前一条仍 pending 且失败未达阈值 → 排队；
    - Channel 判定不可达 → `dropped: channelGone`；Source 不再监听 → `channelIgnored`。
    回执永久保留，保证同一消息 id 不会重复发送（`src/app/store.ts` 的 `receipts`）。
16. 本机形态下 Local Channel 把消息写进 KV（`local-reply:` / `local-thread-replies:`），
    provider 轮询 `/paseo/events` 增量拉取并投影成 `assistant_message`。

## 4. 模块分层与依赖规则

| 层 | 目录 | 职责 | 关键约束 |
| --- | --- | --- | --- |
| 入口 | `src/index.ts`、`src/hosts/paseo.ts`、`src/sources/{github,feishu}.ts`、`src/local/cli.ts`、`src/paseo/mcp.ts`、`src/paseo-ui/` | DSH 插件、Paseo 宿主、watcher、CLI、MCP、provider 与宿主加载器（另有浏览器端 `src/client/index.tsx`） | 入口只装配，不写领域逻辑 |
| 领域核心 | `src/core/` | Engine + Intake/Evals/Tickets/Assignments/Replies、模型、端口、阶段、原因码 | 除 `node:crypto` 哈希外不依赖外部、不做 I/O |
| 应用装配 | `src/app/`、`src/hosts/`、`src/paseo/backend.ts` | 公共 Runtime 组装 Store/Engine/Effects 等业务对象；宿主注入执行器、环境与生命周期 | 两种宿主复用同一套业务装配；副作用经端口入队 |
| 来源与渠道 | `src/sources/` | GitHub / Feishu / Local 的 kind、注册表、轮询、Trigger 翻译、上下文读取、Channel | 不 import `src/app` 运行时代码（仅 `local.ts` 一个类型导入），只经过 `SourceHost`/`SourceContext` |
| 执行 | `src/executor/` | `dsh.ts`、`paseo.ts`、`background.ts` | 只通过 `EngineForExecutor` 回写事实 |
| Paseo 适配 | `src/paseo/`、`src/paseo-control/`、`src/paseo-ui/`、`src/local/`、`paseo-plugin/` | 会话端口、MCP 桥、报告回执、journal、时间线投影、provider | 与 DSH 路径互不侵入 |
| 面板 | `src/client/` | React：overview / source / trigger / eval / execution / settings | 只从宿主侧导入类型和少量纯值模块 |
| 基础设施 | `src/infra/` | CLI 传输（gh / lark-cli）、进程环境与 shim、路径、健康板、文本限制 | |
| 纯值 | `src/policy.ts`、`src/admission.ts`、`src/kv.ts`、`src/limits.ts`、`src/deployment.ts`、`src/navigation.ts` | 策略与准入表、KV 键族、限制、配置、跳转 | |

依赖方向（`docs/007` §Dependency rules，代码可验证）：

- `src/core` 不知道任何 Source、Channel、Session 的存在，只认端口；
- `src/sources/*` 不 import `src/app/*` 的运行时代码，走 `SourceHost` 服务接口（唯一例外是
  `src/sources/local.ts` 对 `Store` 的**类型**导入）；
- `src/app/runtime.ts` 负责公共业务装配，`src/hosts/*` 和 `src/paseo/backend.ts` 注入宿主与执行后端；公共路径不得加载 DSH 的运行依赖；
- 面板客户端只 import `src/app/api.ts` 这类纯类型 + `src/client` 自身。

### 4.1 核心内部：五个分支的单向依赖

`Engine` 是唯一入口，内部五件套（`src/core/engine.ts:31-38`）：

```
Intake ──┐
Evals  ──┼──> Tickets ──> Replies
Assignments ──> Tickets
Assignments ──> Replies
```

| 分支 | 负责 | 不负责 |
| --- | --- | --- |
| `Intake` | trigger 落库、scope 过滤、thread 相关性、订阅扇出、排队 | 不做准入判断（那是 Eval 的 gate） |
| `Evals` | 批次、强度、deadline、Decision、重排队、超时 | 不直接启动执行器（交给 Tickets） |
| `Tickets` | 生命周期、订阅、Input、resume/retry/restart、结束 | 不写 Channel（交给 Replies） |
| `Assignments` | 执行器事实（started/delivered/read/turnEnded/deliveryFailed）、报告、中断恢复 | 不知道具体后端 |
| `Replies` | 四类消息的规则与幂等 id | 不真正发送（Outbox 发送） |

调用者拿不到完整 Engine，只拿到 `Pick`：`EngineForSources` / `EngineForMainSession` / `EngineForPeople` /
`EngineForSettings` / `EngineForExecutor`（`src/core/engine.ts:275-284`）。这是“权限按角色收窄”的代码级实现。

## 5. 必须理解的六个不变量

改这个项目最常见的错误，是绕过下面某一条。

### 5.1 单一写入者

| 状态 | 唯一写入者 |
| --- | --- |
| Trigger / Thread / Decision / Ticket / Assignment | `Engine`（`src/core/*`） |
| 各回执、设置版本、提示词版本、KV | 对应应用部件（`Store` 只提供机制） |
| Outbox 回执 | `Outbox` |
| 各健康条目 | 声明它的那一个部件（`HealthBoard.claim` 会拒绝重复声明） |
| Source 的读游标、thread meta | 该 Source 自己 |

### 5.2 事务与“提交后才产生副作用”

`Store.atomic`（`src/app/store.ts:140`）用 SAVEPOINT 支持嵌套；`afterCommit` 在**最外层事务提交后**才执行，
回滚则丢弃。所有网络/进程副作用都经 `Effects` 入队，因此崩溃不会产生“库没写但消息已发”。

### 5.3 幂等 id

`key()`（`src/core/ids.ts`）由输入派生 id：同一次评估、同一个 assignment、同一条消息、同一个 ack 都有稳定 id。
配合 `INSERT OR IGNORE` / 回执表，重复投递不会产生第二条记录。**不要给同语义对象引入随机 id。**

### 5.4 报告只属于“当前 running assignment”

`isCurrentRunningAssignment`（`src/core/model.ts:324`）：只有最新的、唯一 running 的 assignment 能写报告/
`inputsDelivered`/`inputsRead`。Paseo 路径额外用 `reportForAssignment` 在同一事务里校验，防止迟到报告污染替代者。
Paseo 还有 receipt 表在 `assignmentStarted` 前暂存报告（§6.3）。

### 5.5 Input 的三段状态

`undelivered`（还没交给 worker）→ `deliveredAt`（已投递）→ `readAt`（会话真的把它读进了一步）。
`ticket.end()` 用 `readUntil` 判断“哪些人的消息该退回 Eval”；`waitsForPerson` 时自动输入会被扣住。
DSH 通过 `session/event` 的 `user/message` 确认“已读”；Paseo 没有该钩子，**把发送成功当作消费见证**
（`src/executor/paseo.ts:173-182`，代码注释已说明这是 adapter 的近似）。

### 5.6 订阅 ≠ 授权

Thread 上的 Ticket 订阅只决定“消息能不能到达它”。`thread.context`（只为上下文订阅）里的人和消息**不授予任何权限**，
也不会让已结束的 Ticket 复活。授权永远来自：显式请求（名单内 + @）或 `accept` 时的 Mandate；
恢复时用 `policy.revalidate(mandate)` 再次校验（发送者仍在名单、规则仍启用、模式仍为 auto 等）。

## 6. Paseo 集成（本仓库新增部分）

### 6.1 装配开关

`src/app/runtime.ts:152-197`：有 `machine.paseo` 时才创建 `PaseoAdapter`、`PaseoOperationJournal`、
`PaseoToolBridge`、`PaseoSessions`、`PaseoExecutor`、`PaseoReports`；否则全部走 DSH 原路径。
`Sessions` 与 `PaseoSessions` 实现同一个窄端口（`prompt/relay/notify/delivery/status/promptVersion/mayRead/modelRetry`）。

### 6.2 会话创建（`src/paseo/sessions.ts`）

- 创建参数**先冻结进 KV**（`paseo-session-config:`），重放必须得到同一份配置；
- 系统提示 = `Prompts.compose(role)` + Mandate 指令 + 一段 “Runtime: Paseo …” 的硬约束 + 技能全文；
- MCP 配置固定为 `stdio: node bin/superagent-mcp.mjs`，env 里带 `SUPERAGENT_TOOL_SOCKET` 和一次性 token；
  token 由 `PaseoToolBridge.grant(binding)` 生成，**binding 由宿主决定，模型参数无法指定角色**；
- worker 的 `cwd` 故意设成协调者的 workspace（Paseo 按目录归属 agent），隔离靠 `DSH_SUPERAGENT_DIR`
  与指令里的“先 cd、不许写出目录”；
- `options` 显式清空 `GH_TOKEN`/`GITHUB_TOKEN`/`GIT_CONFIG_COUNT`，避免把宿主凭据带进 worker。

### 6.3 执行（`src/executor/paseo.ts`）

三类 effect：`paseoLaunch`、`paseoDelivery`、`paseoStop`，各自并发上限 1。
所有“创建/发送”都走 `PaseoOperationJournal`（`paseo_operation_intent` 表）：

- `claim()` 第一次返回 `execute`，之后永远 `reconcile`——**“查不到”不等于“没发生”，绝不盲目重发**；
- `observe()` 只接受精确身份（按 label 找到唯一 agent、按 messageId 找到消息）；
- 发送文本先冻结进 KV（`paseo-worker-message:`），重放文本一致；
- 报告经 `PaseoReports` 写 `paseo_report_receipt`，在 `assignmentStarted` 的同一事务里回放，
  因此“报告早于启动确认”也能正确落到当前 assignment；带 PR claim 的报告会与 claim 同事务提交。

停止是**观测**而不是围栏：`paseo_stop_observation` 记录 `request_sent`、`turn_stopped`、`observed_idle`；
代码明确写着没有队列围栏，且“曾经发过消息”就不允许把停止确认为完成。

### 6.4 对话与时间线

- `LocalConversation` 用单调 `seq` 维护会话事件索引，`/paseo/events?after=&through=` 分页；
  provider 用固定 high-water 回放，检测 gap/epoch 变化并显式报错（`src/paseo-ui/connection.ts:62`）。
- `ticket/<id>/transcript` 在 Paseo 形态下读 `PaseoAdapter.timeline()` 并投影：
  `user_message`/`assistant_message`/`tool_call`/`error`/`notification`/`compaction` 保留，
  reasoning、todo、plugin UI 项丢弃（`src/paseo/transcript.ts`）。
  **这是实时视图，不是不可变归档，也不构成完成证据。**

## 7. 提示词与会话权限

`Prompts`（`src/app/prompts.ts`）把提示词拆成可覆盖的“部件”，主 Session 的顺序是：

```
runtime/shared → runtime/orchestrator → [Communication] → [Ticket scope] → [Delivery requirements]
→ subscriptions → replies → dispatch → admission → handoff → environment(生成) → policy(生成，最后)
```

worker 版本把 `orchestrator/dispatch/admission/policy` 换成 `worker/work`，环境段同样生成。
三个团队段（Communication / Ticket scope / Delivery requirements）与技能、内置部件覆盖都可版本化保存，
保存时按 `baseRevision` 做乐观并发，`prompts/defaults` 可看内置原文。

会话权限是**代码限制**而非提示词限制（`src/app/sessions.ts`）：

- 主 Session：`tools.restrict({ allow: ['skill','bash','read','read_image','job_output','job_list','job_kill'] })`
  + 禁止 `sleep`/超长等待的 guard；
- worker：只保留 `WORK_TOOLS`（read/write/edit/glob/grep/bash/jobs/web/skill/todo/subagent…），
  Ticket 结束后 guard 直接拒绝新工作；
- worker 的子代理继承同一套限制，Ticket 结束即失效。

## 8. 数据与磁盘布局

单文件 SQLite（WAL，`synchronous=FULL`，0600），schema 版本 11，打开时自动迁移 10→11（`src/app/migration.ts`）。

| 表 | 内容 |
| --- | --- |
| `trigger` / `disposition` / `trigger_thread` | 不可变事件、去向、线程索引 |
| `thread` | 订阅、上下文订阅、待评估队列、进行中的 Eval |
| `ticket` / `decision` | 工单与决策（JSON 值 + 生成列做“活跃集”） |
| `outbox` | 消息回执（pending/sent/dropped，永久保留） |
| `effect` | 持久化副作用队列（kind/key/seq/generation/due/attempts） |
| `kv` | 设置与提示词版本、回执索引、Source 游标、会话绑定…… |
| `paseo_operation_intent` / `paseo_report_receipt` / `paseo_stop_observation` | Paseo 操作身份、报告回执、停止观测 |

`<stateDir>` 布局（本机为 `~/.dsh/state/sa-paseo-check`）：

```
orchestrator.sqlite(+wal/shm)   领域状态
local-ipc/s                     操作者 Unix socket
agent-ipc/s                     worker 工具桥 socket
paseo-ui-pending/               provider 未对账输入日志
worker-bin/、worker-gitconfig   worker 的 shim 与 git 身份
work/<short name>/              每个 Ticket 的执行目录（默认）
```

目录锁（`proper-lockfile`，stale 30s）保证单进程；锁丢失会中止 Runtime。

## 9. 怎么用

### 9.1 官方形态（GitHub / 飞书）

1. 按 `SETUP.md`，让编码代理带你完成：独立 DSH profile（默认 `superagent`，端口 3082）、专职 GitHub 账号 +
   `gh` wrapper、可选飞书 bot + `lark-cli` wrapper（仅 bot 身份）、面板里的 Sources / Policy / Execution。
2. 启停：`scripts/dsh-superagent start|status|restart|stop`。退出码：`0` 正常、`1` 需重启、`2` 某部件异常、
   `3` 等待 setup。日志在 `.artifacts/`。
3. 打开日志里的地址 → 侧边栏 **Superagent**。面板标签：概览 / Source / Trigger / Eval / 执行 / 设置；
   Ticket 与 Thread 是详情页；设置分组：Source / Eval / Execution / Prompts / Deployment。
4. 在允许名单内的账号到目标仓库 Issue 评论 `@<agent 登录名> <请求>`；约一分钟内概览出现 Ticket。
   之后在同一 thread 继续说话即可（订阅扇出），不用再 @。

### 9.2 本机 Paseo 形态（当前这台机器已就绪，详见 `docs/local-usage.md`）

| 项 | 值 |
| --- | --- |
| DSH profile | `superagent-local-check` |
| Paseo 覆盖配置 | `~/.dsh/profiles/superagent-local-check/paseo.patch.yml` |
| 状态目录 | `~/.dsh/state/sa-paseo-check` |
| 管理面板 | `http://127.0.0.1:3098` |
| Paseo daemon | `ws://127.0.0.1:6767/ws` |
| 角色模型 | `claude-pool/friday-deepseek-v4-flash`，mode `auto` |
| 外部 watcher | GitHub / 飞书插件均关闭；本地请求允许当前 OS 用户 |

源码改动后**必须重建并重载插件**：

```sh
cd /Users/anxiaojie/src/superagent-with-paseo
pnpm build
paseo daemon config set pluginsEnabled true
paseo plugin install ./paseo-plugin --host 127.0.0.1:6767     # 已装过则跳过
paseo plugin reload superagent --host 127.0.0.1:6767
```

启动宿主（前台保留终端）：

```sh
dsh --profile superagent-local-check \
  --patch /Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml --no-open
```

入口自检：

```sh
node bin/superagent-local.mjs --state-dir ~/.dsh/state/sa-paseo-check status
# configured: true, paused: false, accepting: true 才是可用状态
```

提交任务（命令行方式）：

```sh
node bin/superagent-local.mjs --state-dir ~/.dsh/state/sa-paseo-check submit \
  --request-id req-1 --thread-id conv-1 --text '要做的事'
node bin/superagent-local.mjs --state-dir ~/.dsh/state/sa-paseo-check replies --thread-id conv-1
```

- `stored` 只表示 Engine 收到了请求；接单/提问/结果从 `replies`（或 Paseo 窗口）读。
- 结果不确定时用**同一组 request-id/thread-id/原文**重试，重复返回 `duplicate`；改正文复用 ID 会冲突。
- Paseo 窗口只接受纯文本；中断按钮只中断当前输入等待，已受理的 Ticket 仍会跑完。
- 注意：`scripts/dsh-superagent` 默认控制另一个 profile，且不接受这里的覆盖参数；本形态用上面的显式命令。

### 9.3 开发与验证

```sh
pnpm install
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run（69 个 spec）
pnpm build              # tsdown：lib/ + paseo-plugin/server/provider.mjs
pnpm check              # 三者串联
pnpm vitest run tests/paseo-*.spec.ts     # 只跑 Paseo 相关
```

测试是按模块切的：`core-engine` / `policy` / `admission-context` / `effects` / `outbox` / `runtime` /
`paseo-*` / `panel-*` / `client` / `docs`。其中 `tests/docs.spec.ts` 会强制：
编号文档连续、只链接更早的编号文档、本地链接可解析、`007` 的模块表与测试表覆盖全部文件——
**新增源文件通常要同步更新 `docs/007` 的表**。

改动的常见落点：

| 想改 | 去哪 |
| --- | --- |
| 加一个来源 | `src/sources/`，按 `docs/008-cookbook` 十一步；同步 `cordis.patch.yml`、`package.json` exports、`docs/007` |
| 改准入/授权 | `src/admission.ts`（表）、`src/policy.ts`（gate/revalidate）、`src/core/evals.ts` |
| 改工单语义 | `src/core/tickets.ts` + `src/core/model.ts`，再跑 `core-engine`/`stage`/`followups` |
| 改执行行为 | `src/executor/dsh.ts` 或 `src/executor/paseo.ts`；Paseo 改动同时看 `tests/paseo-*.spec.ts` |
| 改面板 | `src/app/api.ts` + `src/app/views/*` + `src/client/*`，并补 `panel-*.spec.tsx` |
| 改提示词文本 | `prompts/`（内置）或面板 Prompts（版本化），注意 `tests/prompts.spec.ts` 与 `docs/004` |

## 10. 已知限制与坑（照代码如实列出）

- **研究原型**：会崩、会不一致；上游文档描述的是 DSH 实现，Paseo 部分是实验分支。
- **Paseo 没有队列围栏**：已确认发送的消息仍可能排队到达；`idle` 观测不能证明所有子进程停了。
  代码把停止记为“观测”，不把重试当成能力。
- **Paseo 不支持静默历史注入**（`{ inject }` 会抛错）；后台通知改为“下一条协调者消息附带”。
- **Paseo 无子作业完成证据**：DSH 的 background jobs/subagents 语义在此退化。
- **本机 socket 只代表同 UID 可信**：同账号的任何程序都能提交请求；不得暴露到 TCP，也不得当作 worker 报告通道。
- **worker 不是安全沙箱**：blockedCommands 只按命令名拦，绝对路径可绕过；`danger-full-access` 权限。
- **记录只增不减**：trigger/disposition/decision/outbox/kv 不会清理，长期运行会持续增长。
- **单 profile 独占**：同一 `stateDir` 只能一个进程；不要同时启动同一 profile 的基线模式与 Paseo 模式。
- **模型配置粘在会话上**：改 profile 的 paseo 模型只影响新会话，已存在的 Paseo 会话仍用创建时的配置。

## 11. 推荐阅读路径

- 想先建立印象：本文 §1–§3。
- 想改授权/安全：`docs/002` + `src/policy.ts` + `src/admission.ts` + `src/core/evals.ts`。
- 想改执行/恢复：`docs/003` + `src/core/tickets.ts` + `src/executor/*`。
- 想改提示词：`docs/004` + `src/app/prompts.ts` + `prompts/`。
- 想加来源：`docs/008` + `src/sources/kind.ts` + `src/sources/registry.ts`。
- 想看全量模块责任表：`docs/007` §Modules（本文不重复它 100 多行的逐文件表）。
