# Superagent 到 Orchestrator 到 Worker 流转画布设计

日期：2026-11-08。状态：书面设计待审阅（基于已确认方向整理，尚未进入实现计划或代码改动）。

基线：当前 `codex/paseo-integration` 工作树，以及已完成迁移验收的 [Paseo 插件宿主设计](./2026-11-08-paseo-plugin-host-design.md) 与 [插件宿主验收记录](../plans/2026-11-08-paseo-plugin-host-validation.md)。本设计在不重启 DSH、不新增第三个常驻服务、不重写 Superagent 核心状态机的前提下，提供只读的本地 Web 流转画布。

## 1. 目标与非目标

### 1.1 目标

提供一个本地只读 Web 页面，把一条请求从 **Superagent 入口 / 控制面 → Orchestrator 主会话 → Worker / Assignment 执行会话 → Outbox / 对话回复** 的主要流转记录、当前状态和证据展示在画布与时间线上，直接回答五个问题：

1. 请求是否已进入系统，以及经过了什么路由决策？
2. 请求关联到了哪个 Orchestrator、哪些 Ticket、哪些 Worker / Assignment？
3. 当前执行处于排队、启动待确认、运行中、等待用户输入、阻塞、失败还是已结束？
4. Worker 汇报了哪些进度、问题或结果，当前采用的是哪一条？
5. 给用户的回复是否已经排队、已发送或被丢弃？

### 1.2 非目标

首版明确不做以下事项：

- 不把画布做成可编辑工作流构建器：不支持增删节点、拖拽连线、改派工、重试、取消任务、发消息或修改 Policy。
- 不为了画布新增任何 LLM 调用、摘要生成或自然语言解释。
- 不重构现有领域模型，也不在首版补建全量 append-only 领域事件库或精确历史状态机回放。
- 不把 Paseo 会话 `idle`、工具调用完成或本地回复入库等同于“任务已完成”或“用户已读”。
- 不依赖 DSH Web 宿主、DSH 客户端模块加载器（`window.__ModuleLoader__`）或外部 CDN。
- 不要求首版必须内嵌进 Paseo 桌面窗口才算交付；先交付本机浏览器可直接打开的只读页面，后续再按需挂接 Paseo 面板入口。

## 2. 总体方案

采用已确认的组合：**`@xyflow/react`（React Flow）只读画布 + 固定三列角色泳道确定性布局 + 独立事件序列/时间线面板 + 宿主进程内只读本地 HTTP 服务**。

核心原则：

- **主图展示结构关系，时间线展示先后顺序。** 主图只放角色节点、Ticket/Assignment 节点和稳定流转边；多次进度汇报、追加输入、投递重试通过边徽标、Assignment 历史展开和底部事件列表查看，不每来一条记录就复制一个 Worker 节点或叠一条新边。
- **React Flow 只做投影展示，不持有业务真相。** 每次刷新都由后端只读投影生成确定性的节点 ID、边 ID 和坐标，前端保留用户当前选中项、折叠状态和视口位置。
- **证据优先，缺失直说。** 现有 SQLite 与 journal 能证明的关联、状态、时间和内容直接展示；现有存储没有记录的时间戳、未确认的外部副作用、被覆盖的旧快照，统一显式标为 `unknown` 或 `unconfirmed`，不伪造精确时间轴或“消息正在线上流动”的动画。

## 3. 页面结构与交互

页面固定为四块区域：

| 区域 | 内容 | 关键交互 |
| --- | --- | --- |
| 左侧：请求 / Ticket 列表 | 按最近活动排序的本地对话请求、未成单请求（`pending` / `ignored` / `rejected` / `unavailable`）与已立项 Ticket | 搜索 ID/标题/文本摘要；按进行中、待人处理、已完成、未成单筛选；点击切换当前画布焦点 |
| 中央：React Flow 只读画布 | 三列固定泳道：左列 Superagent 入口与控制面、中列 Orchestrator、右列选中 Ticket 的当前与历史 Assignment / Worker，以及底部的回复出口节点 | 缩放、平移、适应视口；点击节点或边查看证据；展开/折叠历史 Assignment；刷新时保持当前视口与节点稳定位置 |
| 页面底部：证据浮层（点击后唤起） | 当前选中节点、边或事件的完整安全字段：ID、状态、原因码、时间、请求/任务书/汇报/回复正文、关联 Paseo `agentId`、执行目录与未知项说明 | 复制 ID/路径；切换查看结构化字段与原始只读记录；对当前仍绑定的会话按需手动加载一段只读 transcript 证据 |
| 底部：事件序列与时间线 | 当前焦点请求或 Ticket 的有序事件列表，分为“带时间戳事件”和“仅有序号/意图但无时间戳的记录” | 点击任意事件高亮画布上的相关节点和边，并在右侧打开对应证据 |

### 3.1 默认视图：交付时序

页面默认打开 **交付时序**，而不是关系画布。时序采用四列角色泳道：用户、Superagent / 交付、Orchestrator、Worker；每行是一个按时间排序的步骤，卡片落在实际执行该步骤的角色列，跨角色时用横向箭头表示交接。顶部显示五个交付里程碑（请求已收到、已做出路由决策、已派给 Worker、Worker 已汇报、回复已交付）。每一步显示：步骤号、时间（或“无记录时间”）、角色（用户 / Superagent / Orchestrator / Worker）、阶段、状态、摘要；点击可在右侧查看证据。技术性的 create/send intent 默认折叠，只有勾选“显示技术凭证”才出现。左侧列表默认按会话去重，只展示 Request 与其完整交付链，历史遗留 Ticket 仍在“全部记录”中可查。

关系画布保留为第二个视图，采用 React Flow layouting 示例的点状背景、圆角节点、平滑连线和边标签，保持只读、不可拖动。关系画布提供“重放”模式：第一次点击显示第一步，之后每次“下一步”只增加该时间步骤涉及的节点与连线，并用淡入动画呈现。证据详情不再占用右侧固定列，而是从页面底部唤起可关闭浮层（支持关闭按钮、遮罩点击与 Esc）。

画布交互约束：

- 关闭 `nodesDraggable`、`nodesConnectable`、`elementsSelectable` 以外的编辑能力，不显示连接手柄与删除快捷键。
- 默认只展开当前焦点 Ticket 的最新 Assignment；同一 Ticket 存在多次 Assignment（重开、重试或再次派工）时，旧 Assignment 默认折叠为带计数的历史组，点击后再按序展开。
- 一条请求扇出或关联到多个 Ticket 时，左侧列表和画布顶部显式列出全部关联 Ticket，用户可切换主焦点 Ticket，其它关联 Ticket 以紧凑摘要节点显示，不省略成只剩单条 `receipt.ticketId`。

## 4. 画布模型与确定性布局

### 4.1 泳道与节点类型

坐标由纯函数根据泳道列号和行序计算，不引入 Dagre、ELK 或力导向布局：

1. **Swimlane A（x = 80）：Superagent 入口 / 控制面**
   - `trigger:<triggerId>`：输入请求节点，显示来源（`local` / `github` / `feishu`）、请求序号、发送者、接收时间与入口状态。
   - `control:<evalId|decisionId|triggerId>`：控制面准入与路由节点，显示 `filtered`、`evaluating`、`Decision.kind`（`accept` / `reopen` / `ignore` / `stop` / `unavailable`）、原因码与 Policy 版本。
   - `outbox:<messageId>`：回复交付节点，显示 `acknowledgement` / `reply` / `notice`、Outbox 状态（`pending` / `sent` / `dropped`）、失败重试次数与本地会话记录时间。
2. **Swimlane B（x = 460）：Orchestrator**
   - `orchestrator:<masterId>`：主会话节点，显示逻辑 `masterId`、当前绑定 Paseo `agentId`、模型与模式、主会话健康度，以及与当前请求/Ticket 有证据关联的候选投递、路由决策、汇报转交（relay）和对外回复动作。
3. **Swimlane C（x = 860）：Ticket / Assignment / Worker**
   - `ticket:<ticketId>`：工单头节点，显示标题、Mandate 摘要、当前状态、是否有待答问题（`attention`）、未投递输入数（`undelivered.length`）与结束结果（`ended`）。
   - `assignment:<ticketId>:<assignmentId>`：具体执行批次节点，显示 `Assignment.state`（`pending` / `running` / `ended`）、该批次冻结或确认的 Worker Paseo `agentId`、执行目录 `execution.directory`、最近汇报状态与启动/投递确认状态。
   - `assignment-history:<ticketId>`：当历史 Assignment 超过 1 个时默认显示的折叠节点，展开后替换为按创建顺序排列的历史 Assignment 节点。

### 4.2 边类型

| 边类别 | 起点 → 终点 | 表达含义 | 聚合规则 |
| --- | --- | --- | --- |
| `intake` | `trigger` → `control` | 请求进入控制面并完成去重、来源过滤或进入评估 | 每条 Trigger 一条边 |
| `assessment` | `control` ↔ `orchestrator` | 候选评估投递与 Orchestrator 做出路由/准入决定 | 同一 `evalId` / `decisionId` 合并为一条带状态边 |
| `ticket_open` | `control` → `ticket` | `accept` / `reopen` / `stop` 等决策落到 Ticket | 每个关联 Ticket 一条边 |
| `dispatch` | `ticket` → `assignment` | 启动某个 Assignment 并创建/绑定 Worker 会话 | 每个 Assignment 一条边，徽标显示 create/send journal 确认状态 |
| `followup_input` | `trigger` 或 `orchestrator` → `assignment` | 后续用户消息、reopen、Policy 变更或主会话 note 投递给 Worker | 同一 Assignment 的多条 `TicketInput` 聚合为一条边，显示投递计数、未读/未投递计数，点击查看明细列表 |
| `worker_report` | `assignment` → `orchestrator` | Worker 通过 `orchestrator_report` 上报 `progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped` | 同一 Assignment 的多次汇报聚合为一条回流边，徽标显示汇报总次数与最新状态，点击展开全部 `paseo_report_receipt` 序列 |
| `outbound_reply` | `orchestrator` 或 `assignment` → `outbox` → `trigger` | 确认回复、问题追问、最终结果或通知进入 Outbox 并回到对话 | 每条 `OutboundMessage` 一条记录；多条回复过多时按最新回复 + 计数折叠 |

## 5. 数据来源与证据映射

### 5.1 权威读取源

首版不新建业务表，只从现有 `Runtime` 持有的 `Store` 与文件状态派生只读视图：

| 视图对象 | 权威来源 | 可直接证明的事实 |
| --- | --- | --- |
| 本地对话请求与回复序号 | `KV.conversation.*`、`KV.local.reply`、`KV.local.threadReplies` | 本地会话 `seq`、`requestId`、`clientMessageId`、`triggerId`、回复与 `ticketId` 的关联 |
| Trigger 与扇出/回退流向 | `trigger`、`disposition`、`thread` 表 | 原始输入时间 `trigger.at`、来源过滤原因、`evalId`、`decisionId`、全部 `fanout` Ticket、`context`、`acked`、`handbacks` |
| 路由与准入决策 | `decision` 表 | `Decision.at`、`kind`、`reason`、`triggerIds`、`ticketId`、`mandate`、`audit` |
| Ticket、Assignment 与输入投递 | `ticket` 表 | `createdAt`、`updatedAt`、`ended`、`attention`、`assignments[]`、`inputs[]`（含 `deliveredTo` / `deliveredAt` / `readAt`）、`undelivered[]`、`delivery.error` |
| Worker 多次汇报历史 | `paseo_report_receipt` 表 | 单调递增 `seq`、`ticket_id`、`assignment_id`、`request_id`、完整 `payload`（含汇报 `state` / `summary`）与处理 `result` |
| Paseo 会话创建与消息发送意图 | `paseo_operation_intent` 表 + `KV('paseo-message:*')` | 每个 worker/orchestrator 的 `create` / `send` 意图、`session_id`、`message_id`、`cwd`、`result_id` 是否已确认，以及冻结发送文本 |
| Worker 与 Orchestrator 会话身份 | `paseo_operation_intent(kind='create')`、`KV('paseo-session:*')`、`KV('paseo-session-config:*')` | 当前绑定 `agentId`、每个历史 Assignment 的已确认创建 `result_id`（历史 Worker `agentId`）及脱敏后的模型/模式/工作目录配置 |
| 回复投递状态 | `outbox` 表、`effect(kind='reply')`、`KV.local.reply` | 回复正文、用途、目标渠道、`pending` / `sent` / `dropped` 状态、丢弃时间与原因、当前连续失败次数与错误 |

### 5.2 证据与“未知”边界

设计必须遵守以下真实性约束，禁止前端或接口层自行脑补：

1. **完整扇出优先于单值回执。** `LocalConversation.receipt()` 只取 `decision.ticketId ?? fanout[0]`；画布构建请求关联时必须合并 `TriggerDisposition.fanout`、`Decision.ticketId`、以该 Trigger 为 `origin.triggerId` / `origin.triggerIds` 的 Ticket，以及关联 `OutboundMessage.ticketId`。
2. **历史 Worker 身份按 Assignment 还原。** `paseo-session:worker-<ticketId>` 只保存最新绑定，会被后续 Assignment 覆盖；因此每个 `assignment:<ticketId>:<assignmentId>` 节点的 Paseo `agentId` 优先取 `paseo_operation_intent` 中对应 `(ticketId, assignmentId, kind='create')` 的 `result_id`，仅当该 Assignment 仍是当前最新批次时才回退参考当前 session 绑定。
3. **多次汇报用序号而非伪造时间排序。** `assignment.report` 只保留最新一条汇报并带 `report.at`；历史汇报来自 `paseo_report_receipt`，它有严格递增的 `seq`、完整 `payload` 和 `result`，但没有独立接收时间戳。时间线对历史汇报显示 `report #seq`（若与当前 `assignment.report` 内容一致则附带 `report.at`），其余历史汇报时间标为 `timestamp Not Recorded`。
4. **Journal 操作区分已确认与未确认，且不编造操作时间。** `paseo_operation_intent` 没有时间戳列：`result_id !== null` 显示为 `confirmed`，`result_id === null` 显示为 `unconfirmed`（需对账，绝不表示可安全重发），在时间线上归入对应 Assignment / 会话的“意图与确认证据”分组，不混排成精确时间点。
5. **Orchestrator 主会话消息按证据关联，不按时间猜测。** 主会话的 `paseo_operation_intent` 以 `ticket_id = masterId`、`assignment_id = 'session'` 记录。只有当 `message_id` 或冻结消息正文能精确匹配 `candidate:<evalId>`、特定 `ticketId` 的汇报 relay（`reportRelay` ID）或通知键时，才挂到对应请求/Ticket 的流转中；无法精确归属的主会话记录只放在全局诊断视图，不按时间接近度硬挂到某个 Ticket。
6. **区分工作区与任务执行目录。** Worker 在 Paseo 中为了归入同一 workspace 会使用主会话 `stateDir` 作为进程启动 `cwd`，再切换到 `ticket.execution.directory` 执行。详情面板分别展示“Paseo 启动目录 / 父会话绑定”和“Ticket 独立执行目录”，不在没有实时 Paseo 元数据时根据路径自己推算 `workspaceId`。
7. **区分任务完成、回复已发出与用户已读。**
   - `Assignment.report.state = 'ready'` 表示 Worker 汇报结果就绪；
   - `Ticket.ended.outcome = 'completed'` 表示领域内该 Ticket 已结束；
   - `Outbox.status = 'sent'`（以及本地会话产生 `reply:<id>` 事件）表示回复已写入目标出口；
   - 系统不追踪人类是否已经在 Paseo UI 中读到该回复，因此绝不显示“用户已读”。
8. **实时 Transcript 仅作按需补充证据。** 首版默认刷新完全基于本地 SQLite，不后台轮询 Paseo daemon 的全部 agent timeline。仅当用户在详情抽屉中主动点击“查看当前绑定会话 Transcript”时，后端才对当前仍绑定 `agentId` 的单个会话调用一次有界 `readPaseoTranscript`，并明确标注它不含模型 reasoning、不含每条历史消息时间戳，且不覆盖已被替换的旧 Worker 会话。

## 6. 本地服务、配置、生命周期与安全边界

### 6.1 托管位置与生命周期

画布 Web 服务由承载 `Runtime` 的同一进程可选启动（嵌入式 Paseo 插件宿主 `createPaseoHost`），与现有 `Runtime` 共用同一个已加锁的 `Store` 实例：

- **单一写者不变：** Web 层只调用只读查询辅助函数，不新开第二个 `new Store(...)`（避免在只读路径触发迁移或写锁竞争），也不暴露任何写操作路由。
- **与浏览器标签页解耦：** 打开、刷新或关闭浏览器页面不会启动或停止 Superagent 控制面。
- **随宿主有序关闭：** `Runtime.stop()` / `host.stop()` 时，先停止接受新的 HTTP 请求并销毁空闲连接，等待在途只读请求结束后再关闭 SQLite 和释放 `stateDir` 锁，保证不会出现请求读到已关闭数据库连接的情况。
- **未就绪状态可诊断：** 当宿主处于 `starting`、`needs_setup` 或 `error` 时，页面仍可返回静态壳与 `/api/flow/overview` 诊断状态，明确展示当前宿主阶段与错误详情，不伪装成空任务列表的 `ready`。

### 6.2 配置方式

保持 `HostConfigSchema` 严格校验与向后兼容，新增可选的 `flowWeb` 配置块；未配置时默认不额外占用端口或按显式配置开启：

```ts
flowWeb?: {
  enabled?: boolean        // 默认 false；在本地配置中设为 true 开启
  host?: '127.0.0.1'       // 固定只允许 127.0.0.1，拒绝 0.0.0.0 或外网地址
  port?: number            // 1..65535，例如 17890；测试可用 0 分配临时端口
}
```

同时保持 `paseo-plugin/shared/local-config.ts` 为纯数据导出（不引入跨服务端模块的类型查询），使 Paseo 插件二次编译不受影响。宿主启动后把当前画布监听地址与状态写入只读诊断信息，便于从日志或本地状态查看入口 URL。

### 6.3 安全与脱敏边界

- **仅环回监听：** HTTP 服务强制绑定 `127.0.0.1`，拒绝非环回地址。
- **防跨站读取与凭证泄露：**
  - 所有 `/api/flow/*` 接口只允许 `GET` / `HEAD`，返回 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和限制性的 `Content-Security-Policy`（静态资源全部本机同源加载，不引外部脚本/字体）。
  - 宿主在 `<stateDir>/flow-web/access.json`（权限 `0600`）生成随机访问令牌，并在日志/诊断状态中给出带 `#token=...` 的本机打开链接；前端首次加载从 URL hash 读取令牌（hash 不随外链 Referer 发送）并通过 `Authorization: Bearer <token>` 请求 `/api/flow/*`，阻止本机浏览器里的任意第三方网页直接跨域探测或读取任务内容。
- **严格字段白名单：** 严禁直接序列化 `paseo-session:*` 或 `paseo-session-config:*` 的完整 `options`。接口层必须剔除 MCP 桥 `SUPERAGENT_BRIDGE_TOKEN`、环境变量、完整 `systemPrompt`、技能全文、GitHub/飞书凭证和私有 socket 路径，只返回白名单字段（`agentId`、`provider`、`model`、`mode`、`cwd`、`parent`、角色、状态与业务记录）。
- **不做通用代理：** Web 服务不代理 `<stateDir>/local-ipc/s`、不代理 `<stateDir>/agent-ipc/s`，也不向浏览器暴露 Paseo daemon WebSocket。
- **响应有界：** 列表分页、单 Ticket 汇报数、输入数和可选 transcript 预览均设上限并支持分页/截断标记（`truncated: true`），防止超大文本拖慢宿主事件循环。

## 7. 只读 API 与前端刷新协议

只读 HTTP 接口控制在 4 个端点以内：

1. `GET /` 与 `/assets/*`
   - 返回独立打包的画布前端静态资源（HTML、JS、CSS）。
2. `GET /api/flow/overview?cursor=...&limit=50&filter=...&q=...`
   - 返回宿主状态（`phase`、`detail`、`masterId`、orchestrator 绑定摘要）、计数摘要，以及左侧列表分页项（本地对话请求、未成单 Trigger/Decision、Ticket 摘要）和全库单调水位 `watermark`。
3. `GET /api/flow/items/:kind/:id`（`kind` 为 `ticket` 或 `request`）
   - 返回单个 Ticket 或单条请求（含扇出到的多个 Ticket 摘要）的完整画布投影：`nodes`、`edges`、`timeline`、`details`、`unknowns` 与当前项 `watermark`。
4. `GET /api/flow/transcript/:sessionKey`（可选按需触发）
   - 仅当用户点击查看某个当前绑定会话的实时 transcript 证据时调用，返回有界、脱敏后的只读消息/工具调用摘要；若会话未绑定、已被新 Assignment 覆盖或 Paseo 不可达，返回结构化 `unavailable` 原因。

刷新策略：

- 首版采用**固定间隔轻量轮询（默认 2 秒，页面隐藏时降频到 10 秒）+ 手动立即刷新按钮**。
- 每次轮询先看 `watermark`（由 `conversation-seq`、最新 `ticket.updatedAt`、`decision` 最大 rowid、`paseo_report_receipt` 最大 `seq`、`paseo_operation_intent` 行数与确认数、`outbox` 状态摘要合成）；水位未变时不重算画布、不重置选中态。
- 水位变化时只更新节点/边的 `data` 与新增项，保持已有节点坐标和 React Flow 视口（`zoom` / `pan`）稳定。

## 8. 模块划分与构建边界

在不触碰旧 DSH 浏览器插件入口（`src/client/index.tsx` → `lib/client.js`）的前提下，新增独立且职责单一的模块：

| 模块路径 | 职责 | 依赖边界 |
| --- | --- | --- |
| `src/flow-web/model.ts` | 前后端共享的只读画布 DTO、节点/边/时间线/未知项类型定义与 Zod 校验 | 纯类型与数据结构，不依赖 Node、SQLite、DSH 或 React |
| `src/flow-web/project.ts` | 从 `Store` 只读记录派生 `overview` 与单请求/单 Ticket 的 `nodes`、`edges`、`timeline`、`unknowns` 及确定性泳道坐标；负责敏感字段白名单脱敏 | 只读依赖 `Store` / `KV` 查询结果，不写库、不调 Paseo 网络 |
| `src/flow-web/server.ts` | `127.0.0.1` 只读 HTTP 服务、Bearer token 校验、静态资源托管、4 个只读路由与优雅关闭 | Node `node:http` + `project.ts`，可在 `createPaseoHost` 中挂载并随 `stop()` 关闭 |
| `src/flow-web/ui/*` | React + `@xyflow/react` 独立单页应用：左侧列表、中央泳道画布、自定义节点/边、右侧证据抽屉、底部事件时间线 | 仅浏览器端 React / `@xyflow/react` / CSS，不导入任何 `@deepseek-ai/*` 包 |
| `tsdown.config.ts` | 新增独立浏览器构建入口（输出到 `lib/flow-web/`，使用标准浏览器 ESM/IIFE，不使用 `window.__ModuleLoader__` 包装），并由 `packagePath('lib', 'flow-web')` 定位静态文件 | 与现有 `paseo-plugin/server`、`lib/paseo-host.js`、`lib/client.js` 构建互不干扰 |

## 9. 验证与验收标准

后续实现阶段必须通过以下验证才算完成：

1. **纯投影单元测试（`tests/flow-web-project.spec.ts`）：**
   - 覆盖单请求 → Eval → Decision（`accept` / `ignore` / `rejected` / `unavailable`）→ Ticket → 单/多 Assignment → 多次 `paseo_report_receipt` → Outbox 回复的完整节点、边与时间线映射；
   - 覆盖一条 Trigger 扇出到多个 Ticket 时，完整展示全部关联 Ticket；
   - 覆盖多 Assignment 时历史 Worker `agentId` 从 `paseo_operation_intent(kind='create')` 还原，不被最新 session 绑定覆盖；
   - 覆盖无时间戳的 `paseo_report_receipt` 与 `paseo_operation_intent` 不会生成伪造时间戳，未确认操作显式标记为 `unconfirmed`；
   - 覆盖敏感信息脱敏断言：响应 JSON 中绝不包含 `SUPERAGENT_BRIDGE_TOKEN`、环境变量值或完整 prompt 文本。
2. **HTTP 服务与生命周期测试（`tests/flow-web-server.spec.ts`）：**
   - 验证仅绑定 `127.0.0.1`，缺少或错误 Bearer token 返回 `401`，非只读方法返回 `405`；
   - 验证宿主 `starting` / `needs_setup` / `ready` / `stopping` 各阶段的状态响应，以及 `host.stop()` 时先关闭 Web 服务再关闭 SQLite。
3. **前端组件与构建测试（`tests/flow-web-ui.spec.ts` + `pnpm check`）：**
   - 验证三泳道节点渲染、点击时间线事件高亮对应节点/边、历史 Assignment 折叠/展开、轮询刷新保持选中项与视口；
   - 验证独立 Web 构建产物不包含 `@deepseek-ai/*` 或 `window.__ModuleLoader__` 依赖，且 `pnpm check`（`typecheck`、`test`、`build`）全绿。
4. **本机真实数据只读冒烟：**
   - 对本机现有状态目录中的历史 Ticket 启动只读画布页面，确认能看到真实的本地请求、Orchestrator、Worker Assignment、汇报与回复链路，且不对生产状态产生任何写入。
