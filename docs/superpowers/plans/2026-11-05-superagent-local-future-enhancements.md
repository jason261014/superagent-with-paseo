# Superagent Local Future Enhancements — Deferred

> 本文仅保留完整增强方向，不作为当前执行清单。当前以最小适配计划为准；以下任务未获逐项实施授权。

> **For agentic workers:** Implement this plan one task at a time, run each task's tests before moving to the next, and track progress with checkbox (`- [ ]`) syntax.

**Goal:** 在 DeepSeek fork 内交付无需 GitHub/飞书的本机 Paseo 协调闭环，支持代码和非代码任务、持久反馈、固定交付与明确评审。

**Architecture:** 新增独立本地宿主，组装现有 Engine、SQLite Store、Effects 和 Paseo 适配，独占私有状态目录；原 DSH 宿主和旧任务语义继续保留。CLI、Paseo 协调会话和绑定执行实例的 worker helper 共用一个事实源；持久化队列先记录意图再执行副作用。

**Tech Stack:** Node.js `^22.19.0 || >=24.0.0`（现有项目约束；新增 SQLite API 须核对最低版本）、TypeScript、pnpm 11.7.0、Vitest、`node:sqlite`、`@getpaseo/client` 0.8.0、Paseo CLI、Git。

**Spec:** [2026-11-05-superagent-with-paseo-local-design.md](../specs/2026-11-05-superagent-with-paseo-local-design.md)。先读 spec 全文；本文的新增接口为实现契约，不代表现有代码已提供。

## 范围修正：先最小适配验证

用户进一步强调以官方原型为基础、尽可能小改动进行功能验证。下面 10 个任务描述的是完整本地工具目标，范围超过第一轮适配验证；不得将其作为当前默认执行清单。

第一轮只验证两类替换：本地 Source/Channel 替代 GitHub/飞书作为输入输出入口；Paseo 适配替代主会话和执行者的 DSH 会话接入。主会话的模型可调用工具、资源读取、报告和回调是会话接入的一部分，不能只换 worker 创建函数。保留官方 Engine、Policy、Ticket/Assignment/Subscription、SQLite、Effects、Outbox、提示词和既有生命周期，优先复用已有应用模块，只有被 DSH/Cordis 或 GitHub setup 直接阻塞的组装点才做窄接口改造。

不在本轮新增版本化验收状态机、独立交付平台、完整多任务拆分协议、通用多 runtime 注册框架或新一套调度引擎。跨机、非 Git 通用任务、复杂上下文冻结和独立检查先保留为后续增强。已有实验模块并不构成本轮必须接线的要求，也不能因为已经写了代码而扩大范围。

验证顺序：

1. 使用现有官方路径和测试，记录显式请求 → 接单 → 派工 → 进展/问题 → 回复 → ready 的基线事实。
2. 添加最薄的本地 Source/Channel，仍走原 Policy、Engine 和 Outbox；先验证消息入口替换，DSH 会话暂不变。
3. 盘点 Sessions、DshExecutor、模型工具和资源对 DSH 的依赖，提取必需的会话端口；先让现有 DSH 实现经过端口且回归通过，再接 Paseo 主会话和 worker。遇到不具备等价能力的部分明确记录，不能无声降级。
4. 在专用演示会话中以相同任务验证本地入口 + Paseo：问题/答复、后续输入、ready、重启恢复和实际中断观测。保留官方完成语义，明确 ready 不是新增的独立验收结论；没有消息栅栏时只报告中断请求和当前观测。

第一轮通过后再根据实际缺口选择下面的增强任务。只有应用装配必需的薄本地宿主属于本轮，不复制官方 Store/Effects，也不同时强制原路径与新路径各维护一套领域模型。本文件后续需要据此重排详细任务，在重排前不启动完整实现。

## Global Constraints

- 同一个 fork 内工作；不推送、不新建 PR，不更改用户现有 DSH、Paseo 会话或原工作区。仅使用专用临时目录和新建标记的演示会话。
- 默认不监听 GitHub/飞书、不主动接单；本地内部反馈服务需要明确启动。禁止自行发起审批、解禁、发布审批或流程中心申请。
- 主协调会话和每个任务有明确绑定；CLI 成功接收不等于已执行。Codex 桌面回合不被假定为可后台唤醒。
- 缺失目标、权限 mode、基线、文件、调用能力或结果不明确时拒绝/保留 unknown；不能默认扩大权限或盲目重发。
- 同一状态目录只有一个持锁宿主；事件、交付及结论以该宿主的 SQLite 为权威，文件按摘要校验；原有 DSH 状态目录及其语义不得复用或修改。
- worktree 不构成安全沙箱，helper token 不隔离同 UID 的恶意进程或 root；Paseo stop 不证明子进程已退出。
- 现有 1238 项测试和既有能力探针不是本计划端到端验收。每次变更 `src/` 或 `tests/*.spec.ts` 时更新 `docs/007-architecture.md` 的模块或测试表。
- 按任务精确暂存本计划文件，不执行全目录暂存或 reset；只有用户明确授权时才推送。各任务中的提交为本地提交。

## Review Focus

1. 相同请求 ID 配不同正文：Task 2 的同事务冲突测试必须拒绝且不产生第二次任务。
2. 本地请求没有 GitHub Channel：Task 2 的真实 Engine 测试必须能持久化问题、主 agent 答复并从本地入口取回。
3. 报告在 assignment 标记 running 前到达，且宿主在 ACK 后崩溃：Task 5 必须补收原事件，旧 assignment 不可污染新实例。
4. 快照有未跟踪二进制、可执行位、删除和工作目录继续改动：Task 7 必须可独立复原原版，无法确认安全完整时不得展示可评审。
5. stop 后旧消息可能再次唤醒：Task 9 必须区分请求、观测和稳定停止，缺栅栏时保持 unknown；重启和 cwd 不匹配不误停他人会话。

## 文件结构与接口

以下是各任务共享的目标边界。任务内实现可拆分文件，但不得修改签名而不同时更新所有调用和测试。

| 文件 | 责任 |
| --- | --- |
| `src/local/contracts.ts` | 本地请求、事件、交付、身份与只读状态 DTO。 |
| `src/local/settings.ts`, `host.ts`, `read.ts` | 私有配置、单实例生命周期、只读投影；不经过 DSH setup。 |
| `src/local/ingress.ts`, `transport.ts`, `channel.ts` | 凭能力校验的同机入口、原子去重、收件和本地回复通道。 |
| `src/local/coordinator.ts`, `notices.ts`, `tools.ts` | Paseo 主会话绑定、候选路由、可靠通知及模型可调用的操作桥。 |
| `src/local/workspace.ts`, `context.ts` | 冻结目标/材料、独立 Git 与非 Git 工作目录。 |
| `src/executor/report-protocol.ts`, `report-receiver.ts`, `report-helper.ts` | 绑定 assignment 的结构化报告与有序持久接收。 |
| `src/executor/paseo.ts`, `src/paseo/client.ts`, `src/paseo-control/journal.ts` | 复用并扩充 Paseo 适配、单观察者、操作对账及停止记录。 |
| `src/delivery/snapshot.ts`, `store.ts`, `review.ts`, `checks.ts` | 不可变成果、发布恢复、版本化结论及可选检查证据。 |
| `src/cli/superagent.ts`, `src/cli/client.ts`, `tsdown.config.ts`, `package.json` | 用户 CLI、受控 IPC、可执行构建入口。 |
| `tests/local-*.spec.ts`, `tests/paseo-*.spec.ts`, `tests/delivery-*.spec.ts` | 新闭环针对性测试；共享测试夹具在 `tests/fixtures/local.ts`。 |

统一 DTO（在 Task 1 实现；所有 `id` 是不可为空的工具生成字符串）：

```ts
export type Caller = { kind: 'operator' | 'coordinator' | 'worker'; id: string }
export type LocalRequest = { requestId: string; command: string; payload: unknown }
export type AuthenticatedRequest = LocalRequest & { caller: Caller }
export type Receipt = { requestId: string; state: 'received'; taskId?: string }
export type WorkerEvent = { eventId: string; taskId: string; assignmentId: string; seq: number;
  kind: 'progress' | 'needs_input' | 'delivery' | 'execution_error'; body: string;
  bodyRef?: { id: string; sha256: string; size: number }; inputIds?: readonly string[] }
export type EventReceipt = { state: 'stored' | 'duplicate' | 'pending_gap'; contiguousSeq: number }
export type DeliveryRef = { taskId: string; assignmentId: string; deliveryId: string; manifestSha256: string }
export type Disposition = { taskId: string; deliveryId: string; outcome: 'accepted' | 'rework'; note: string }
export type StopView = { request: 'not_sent' | 'sent' | 'unknown'; runtime: 'running' | 'idle' | 'unknown';
  stableStopped: boolean | 'unknown'; unknownChildren: true }
```

入口固定 `submit(request: LocalRequest, capability: string): Promise<Receipt>`；读取固定 `status(taskId?: string): Promise<unknown>` 和 `result(taskId: string, deliveryId?: string): Promise<unknown>`；报告接收固定 `receive(event: WorkerEvent, capability: string): Promise<EventReceipt>`。正文超过 64 KiB 用持久化附件引用，不截断后冒充完整正文。`operationId`、`eventId`、`messageId`、`deliveryId` 和序列号由工具生成；不根据文本推断身份。

`Receipt.requestId` 标识用户请求；协调者接受后才有任务。一个请求可拆成多个 ticket，用独立关系表保存 request→ticket，而不是篡改原 trigger 身份或期待 `Engine.decide` 重复接受同一 trigger。`taskId` 对应现有 `Ticket.id`，不另造第二套任务实体。状态和结果不得直接返回数据库整行，投影只包含经过裁剪的运行、报告、交付和结论字段，绝不带 capability。

本地配置结构固定如下；`init` 写配置，`service start` 读配置并启动，无配置不自动推断：

```ts
export type FrozenTarget = { id: string; provider: string; model: string; mode: string;
  workspace: { kind: 'git'; repository: string; baseRevision: string } | { kind: 'files'; root: string } }
export type FrozenInput = { taskId: string; assignmentId: string; text: string; target: FrozenTarget;
  files: readonly { source: string; relativePath: string; sha256: string; size: number }[] }
export type LocalSettings = { version: 1; stateDir: string; workspaceRoot: string;
  paseoUrl: string; coordinator: { provider: string; model: string; mode: string };
  targets: Record<string, FrozenTarget>; maxWorkers: number }
```

`maxWorkers` 是显式配置的正整数，初次配置为 2；保留主协调者独立的响应能力，不以 worker 长时间运行来占据协调回合。配置中不保存明文 capability，磁盘能力文件单独 0600 保存，数据库记录其摘要。状态目录持久化标记 `hostKind=local-paseo`；标记缺失且已有非空数据库时拒绝接管，避免误用 DSH 数据。增加独立本地 schema 版本与事务迁移，保持原 DSH schema 版本和迁移不变。

下列代码块是行为断言示例；测试作者须在列出的测试文件或 `tests/fixtures/local.ts` 定义所有示例 helper，不从未实现的产品 API 虚构结果。fixture 的写操作调用真实 Store/Engine，只有网络和进程失败点允许模拟。

---

### Task 1: 私有本地宿主与只读查询

**Files:** Create `src/local/contracts.ts`, `src/local/settings.ts`, `src/local/host.ts`, `src/local/read.ts`, `tests/fixtures/local.ts`, `tests/local-host.spec.ts`; modify `docs/007-architecture.md`.

**Interfaces:** 提供 `openHost(settingsPath: string): Promise<LocalHost>`；`LocalHost.start(): Promise<void>`、`close(): Promise<void>`；`readStatus(stateDir: string): Promise<unknown>`。读取仅以 SQLite 只读方式打开已存在的本地数据库，不调用会建目录、chmod 或迁移的 `new Store()`。

- [ ] 编写测试：同一目录第二宿主拒绝、初始化失败释放锁、关闭顺序为停止接收 → `Effects.drain()` → 关闭 DB → 解锁；第二个进程也不能持锁。测试缺失目录和旧 schema 的只读查询不会创建文件、迁移、启动 Paseo 或持锁宿主。

```ts
it('does not initialize state for a read', async () => {
  await expect(readStatus(missingDir)).rejects.toThrow('NOT_INITIALIZED')
  expect(existsSync(missingDir)).toBe(false)
})
```

- [ ] 运行 `pnpm exec vitest run tests/local-host.spec.ts`，确认测试因接口缺失失败。实现 0700 本地目录和 0600 配置检查、显式 host.start/close、独立状态锁；先锁再 `new Store`，初始化失败按逆序释放。禁止把现有 DSH 状态目录配置成本地目录。
- [ ] 在本地主机中组装 `Store`、`Effects`、`Engine`、明确拒绝未知 Source 的 scope，以及独立本地就绪条件；先注入测试 assessor/executor/outbox，不能因缺 GitHub setup 将本地主机永久暂停。fixture 提供 `makeLocalFixture(): Promise<{host: LocalHost; close(): Promise<void>}>`。
- [ ] 实现单一调度循环：请求提交及事务提交后触发 pass，pass 内调用 `Engine.evaluateDue()` 并唤醒到期 Effects；定时器处理退避到期，关闭时清理。运行调度和暂停状态以本地设置为准，不启动官方 Source loops。增加“没有新请求时到期效果仍重试”和“重复 kick 不并发执行 pass”的测试；本地 schema 迁移失败整体回滚。
- [ ] 重跑 `pnpm exec vitest run tests/local-host.spec.ts tests/runtime.spec.ts`，通过后只暂存本任务文件并本地提交 `feat: add isolated local host lifecycle`。

### Task 2: 明确授权的本地入口和回复通道

**Files:** Create `src/local/transport.ts`, `src/local/ingress.ts`, `src/local/channel.ts`, `tests/local-ingress.spec.ts`; modify `src/sources/local.ts`, `src/local/host.ts`, `docs/007-architecture.md`.

**Interfaces:** `submit(request, capability)` 返回 `Receipt`；本地 Channel 持久化 `{messageId, taskId, text}` 并支持 `readMessages(taskId: string): Promise<readonly string[]>`。服务端根据 capability 生成 `AuthenticatedRequest.caller`；外部报文出现 caller 字段直接拒绝。

- [ ] 编写真实 SQLite/Engine 测试：同 `requestId` 同规范内容返回同收据，不同内容回滚并抛 `REQUEST_CONFLICT`；来源未启用、错误 capability 和未注册 Source 均拒绝；本地 trigger 必须包含可回复 Channel，问题和答复能从 `readMessages` 取回。

```ts
it('rejects request identity reused with different payload', async () => {
  await ingress.submit(request('r1', 'one'), operatorCapability)
  await expect(ingress.submit(request('r1', 'two'), operatorCapability)).rejects.toThrow('REQUEST_CONFLICT')
  expect(await countLocalTriggers(store)).toBe(1)
})
```

- [ ] 测试先运行并确认缺接口失败。使用本地 Unix socket（socket 0600、父目录 0700）及随机 capability（0600）认证；operator、coordinator、worker capability 分角色，worker capability 与 task/assignment 绑定，只存摘要并在日志中脱敏。此机制适用于可信本机账户，不声称隔离同 UID 恶意进程。每次请求的去重键、规范化正文摘要和 `Engine.receive` 放在同一 `store.atomic`；未知 Source fail closed。
- [ ] `run` 只生成进入 gate 的明确候选和本地 Channel，不直接创建 worker；用户/协调者/worker 操作权限分别校验。暂停或关闭后新请求拒绝，持久事件不丢失。
- [ ] 校验命令权限矩阵：operator 可提交、读、send、stop、close；coordinator 只能在继承的请求授权和配置目标内 route、dispatch、答复、评审和 close；worker 只能为绑定实例读取材料、读取待收消息、回报和提交交付。所有 payload 用严格 schema 拒绝未知字段；body 限 64 KiB、socket 连接和单请求有超时，日志不打印能力和报文原文。
- [ ] 运行 `pnpm exec vitest run tests/local-ingress.spec.ts tests/paseo-local-source.spec.ts tests/sources.spec.ts`，通过后本地提交 `feat: add authenticated local task ingress`。

### Task 3: 冻结输入和独立工作目录

**Files:** Create `src/local/context.ts`, `src/local/workspace.ts`, `tests/local-workspace.spec.ts`; modify `src/executor/paseo.ts`, `src/local/host.ts`, `docs/007-architecture.md`.

**Interfaces:** `freezeInput(request: {taskId: string; assignmentId: string; text: string; target: FrozenTarget; files: readonly string[]}): Promise<FrozenInput>`；`prepareWorkspace(input: FrozenInput): Promise<{cwd: string; baseRevision?: string}>`。`FrozenTarget` 含目标、provider、model、明确 mode、workspace 类型及绝对路径；代码基线记录解析后的完整 Git SHA。

- [ ] 写测试：两个 assignment 的 cwd 不同；配置更新不改变旧任务；不存在的基线、缺 mode、目录越界、符号链接和文件缺失均在派发前失败；非 Git 任务不依赖 Git；未提交草稿按显式清单固定且原路径映射可读。

```ts
it('keeps the original execution mode after settings change', async () => {
  const frozen = await freezeInput(inputFor('task-a', {mode: 'default'}))
  await saveSettings({mode: 'full-access'})
  expect((await reloadFrozen(frozen.assignmentId)).target.mode).toBe('default')
})
```

- [ ] 先运行失败测试。SQLite 原子保存原始指令、目标及材料清单/摘要；Git 任务由工具在受控根下创建独立 worktree 并绑定完整基线，非 Git 创建独立目录。创建前后写入稳定 intent，以路径和 assignment 对账；不覆盖已有目录、不自动删除、不能验证来源或文件完整性时拒绝发送。
- [ ] 移除当前 `PaseoExecutorHost.createOptions` 靠调用者临时重算的假设，改为从 `FrozenInput` 读取。保证 `cwd/provider/model/mode` 与重启前一致；留出 Paseo 支持字段验证，未支持字段报错而不静默丢弃。
- [ ] 运行 `pnpm exec vitest run tests/local-workspace.spec.ts tests/paseo-executor.spec.ts`，本地提交 `feat: freeze task inputs and isolated workspaces`。

### Task 4: 稳定执行身份与 Paseo 观察

**Files:** Modify `src/paseo/client.ts`, `src/executor/paseo.ts`, `src/paseo-control/journal.ts`; create `tests/paseo-observe.spec.ts`; modify `tests/paseo-executor.spec.ts`, `docs/007-architecture.md`.

**Interfaces:** `observe(agentId: string, onUpdate: (snapshot: RuntimeSnapshot) => void): Promise<() => Promise<void>>`；已有 `findByLabels` 和 `findMessage` 返回完整/未知三态，不改变原有返回语义。

- [ ] 为公共 SDK 观察写测试：订阅 ready 超时、断线重连历史补收、epoch 改变或 gap 保持 unknown、一个 assignment 只有一个 observer；重复快照不造成重复业务事件。保留多页 labels 查询与消息 ID 测试。

```ts
it('does not treat an incomplete label scan as absence', async () => {
  paseo.listPage.mockResolvedValueOnce({entries: [], pageInfo: undefined})
  expect(await adapter.findByLabels({assignment: 'a'})).toMatchObject({kind: 'unknown'})
})
```

- [ ] 实现仅依赖 Paseo 公共 SDK 的订阅、重连和释放，限定 loopback 或经已建立 SSH 转发的 loopback；沿用写前 intent，结果不明通过完整分页 labels + cwd、或 exact messageId 对账。绝不以空结果证明远端请求没发生并重发。创建/发送纯本地参数校验应在 intent 之前完成。
- [ ] 用 `tests/paseo-executor.spec.ts` 的真实 Engine/SQLite/Effects fixture 测试重启和网络响应丢失，不得创建第二个会话或发送第二遍；运行 `pnpm exec vitest run tests/paseo-client.spec.ts tests/paseo-control-journal.spec.ts tests/paseo-observe.spec.ts tests/paseo-executor.spec.ts` 并本地提交 `feat: observe and reconcile Paseo assignments`。
- [ ] 将 `maxWorkers` 接到持久 effect 的并发限制，启动前同步预留槽位，创建结果不明的实例仍占槽；重启先恢复已绑定实例再派发，不能因观察断线释放槽位超额启动。测试两个并发启动竞争最后一个槽、后台工作状态未知不当作空闲、协调者通知不被 worker 并发限制阻塞。

### Task 5: 结构化报告桥与已读见证

**Files:** Create `src/executor/report-protocol.ts`, `src/executor/report-receiver.ts`, `src/executor/report-helper.ts`, `tests/paseo-reports.spec.ts`; modify `src/core/engine.ts`, `src/core/assignments.ts`, `src/executor/paseo.ts`, `src/local/transport.ts`, `docs/007-architecture.md`.

**Interfaces:** `receive(event, capability)` 使用 Task 1 DTO；`Engine.inputsReadForAssignment(taskId: string, assignmentId: string, inputIds: string[]): void` 在同一事务核验当前 assignment 与每个 input 的 `deliveredTo`。helper 从受限配置自动绑定身份，调用者不提供可变 task/assignment。

- [ ] 测试事件按 `eventId + seq + payload hash` 原子保存：先存后 ACK，重复相同返回 `duplicate`，冲突拒绝，缺序返回 `pending_gap` 不越过缺口；assignment 仍 pending 时报告也持久化，变 running 后顺序应用；ACK 前后重启均可补收且不产生重复处置。

```ts
it('retains an early event until the assignment starts', async () => {
  expect(await receiver.receive(event({seq: 1}), workerCapability)).toMatchObject({state: 'stored', contiguousSeq: 1})
  expect(await appliedReports(taskId)).toEqual([])
  await markAssignmentRunning(taskId, assignmentId)
  expect(await appliedReports(taskId)).toHaveLength(1)
})
```

- [ ] 加入 `inputsReadForAssignment`，旧 assignment、未送到该 assignment 的 input 均不能更改已读状态；Paseo timeline 有 messageId 仅证明消息存在，不作为实际读取见证。无可靠见证时保持 unknown，结束任务时不得将其转换成已处理。
- [ ] helper 在专用私有目录持久化递增 seq 和待发 outbox，使用锁将分配序号与原始事件写入原子完成；发送失败复用同一事件，接收端返回连续存储游标，helper 不跨缺口清理。给 worker 提供 `inbox read` 与 `inbox acknowledge --input <id>` 命令；ack 只记录执行者明确声明读取，注明不是后端证明模型推理采用。不从任何普通报告时间戳补造已读。
- [ ] 为 `progress/needs_input/delivery/execution_error` 做大小、来源、身份校验；报文超过 64 KiB 使用持久化附件引用；只允许当前 assignment 应用业务效果，迟到事件保留历史。实现 `report-helper` 通过 Unix socket 和 assignment capability 发报；不得从自由文本或 idle 推断完成。
- [ ] 运行 `pnpm exec vitest run tests/paseo-reports.spec.ts tests/core-engine.spec.ts tests/paseo-executor.spec.ts`，本地提交 `feat: persist assignment-bound worker reports`。

### Task 6: 协调者、内部通知与 CLI

**Files:** Create `src/local/coordinator.ts`, `src/local/notices.ts`, `src/local/tools.ts`, `src/cli/superagent.ts`, `src/cli/client.ts`, `tests/local-coordinator.spec.ts`, `tests/local-cli.spec.ts`; modify `src/local/host.ts`, `package.json`, `tsdown.config.ts`, `docs/007-architecture.md`.

**Interfaces:** `notify(coordinatorId: string, eventIds: readonly string[]): Promise<void>`；`dispose(eventId: string, action: 'answered' | 'reviewing' | 'waiting_user' | 'closed'): Promise<void>`；`route(requestId: string, items: readonly {itemId: string; title: string; text: string; scope: string; targetId: string}[]): Promise<readonly string[]>` 返回 ticket IDs。CLI 输出结构化 `Receipt`、状态或结果，所有主 agent 操作仍走 Task 2 授权入口。

- [ ] 用真实 Engine/SQLite 和模拟 Paseo 测试：主 agent 忙时合并排队，普通进度不唤醒；问题或完整交付触发稳定 messageId；发送成功/观察到新回合不等于处置；离线、重复通知、已处理重启恢复不重复写操作。工具调用必须区分 operator/coordinator，不允许 worker 冒充 coordinator。

```ts
it('retains an event after a notification is delivered but not disposed', async () => {
  await queueQuestion('event-1'); await coordinator.notify('main', ['event-1'])
  expect(await pendingEvents()).toContain('event-1')
  await coordinator.dispose('event-1', 'answered')
  expect(await pendingEvents()).not.toContain('event-1')
})
```

- [ ] 实现基于持久化 eventId 集合的通知批次和发送结果对账，主会话 busy 不打断，投递意图固定后新事件进入下一批；协调工具读取完整正文和附件。重启使用原 messageId，查不清保持 unknown。
- [ ] 实现 `superagent init --config <path>`：校验上述 LocalSettings，明确创建私有本地状态目录、coordinator 工作目录和角色能力文件；只为本工具创建带唯一标签的主会话，创建意图与 sessionId 持久化后按身份恢复，查不清不创建第二个。`service start` 绑定该主会话，不随意接管用户既有会话。主会话提示词提供本地 CLI 的确切绝对入口和 coordinator 能力文件位置，模型通过终端工具调用命令；当前 provider 无终端工具则 doctor 报能力不足，不启动自动协调。
- [ ] 实现协调者 route：从已接收请求派生稳定 `itemId` 的子 trigger，继承原请求授权并绑定 request→ticket，禁止在已有 itemId 上改变正文、目标或 scope。每个子 trigger 经 Engine gate/decide，冻结输入后派发。测试一个请求拆为两个 ticket，route 重试不重复建任务，越出已配置目标拒绝；follow-up 通过原 ticket 进入同一工作上下文。
- [ ] 支持直接在专用 Paseo 主会话对话：适配器读取专用会话的公开 timeline，持久化游标并将可核实的用户输入登记为请求；由工具送入的通知、worker 报告和模型消息不能成为新的用户授权。主 agent 的 `superagent request --message <id>` 只能引用适配器已确认的用户消息，不能仅提交一段文字伪造来源。若公共 SDK 无法区分真实用户输入和工具注入，doctor 明示此能力不可用，直接对话路径列为未通过验收，继续完成 CLI 明确提交路径，不放宽 gate 或伪称整体已交付。
- [ ] 实现 `superagent run <text>`、`status [task]`、`result <task> [delivery]`、`send <task> <text>`、`stop <task>` 和 `doctor`；`service start` 首版前台运行，`service stop` 通过本地 IPC 停止宿主并保留 worker；查询不得暗中启动服务。`run` 返回接收身份，不能表示已派发。CLI 构建在 `tsdown.config.ts` 增加独立 Node 入口，`package.json` 增加 `bin`，保留官方现有 exports，并从独立入口加载，测试不得导入 DSH Runtime 或启动 Cordis。
- [ ] 测试 CLI 离线/无状态只读行为、重复 ID 不同内容冲突、缺能力拒绝以及退出码；运行 `pnpm exec vitest run tests/local-coordinator.spec.ts tests/local-cli.spec.ts tests/docs.spec.ts`，本地提交 `feat: coordinate local tasks via Paseo and CLI`。

### Task 7: 完整固定交付与崩溃恢复

**Files:** Modify `src/delivery/snapshot.ts`; create `src/delivery/store.ts`, `tests/delivery-store.spec.ts`; modify `tests/delivery-snapshot.spec.ts`, `src/executor/report-receiver.ts`, `docs/007-architecture.md`.

**Interfaces:** `prepareDelivery(input: {taskId: string; assignmentId: string; deliveryId: string; cwd: string; baseRevision?: string; selections: readonly string[]}): Promise<DeliveryRef>`；`readDelivery(ref: DeliveryRef): Promise<{manifest: unknown; files: ReadonlyMap<string, Uint8Array>}>`。

- [ ] 构造临时 Git 项目，基线后同时产生 tracked 修改/删除/重命名、未跟踪二进制、可执行位和文档附件；捕获 delivery1 后继续改源目录，在新目录重建并逐文件比较 delivery1。对非 Git 文档目录运行同样的内容/摘要检查。

```ts
it('keeps the first delivery after source files change', async () => {
  const first = await prepareDelivery(deliveryInput('d1'))
  await writeFile(join(workspace, 'new.bin'), Buffer.from([9, 9]))
  expect((await readDelivery(first)).files.get('new.bin')).toEqual(Buffer.from([0, 255]))
})
```

- [ ] 防止范围逃逸及父目录 symlink 替换：仅采集显式受控范围的可信、暂停写入工作目录；通过描述符逐级安全读取或等效可验证机制确保路径不越界，平台无法保证时拒绝发布。对采集前后发现变化拒绝；不能将这个限制表述为抵御同 UID 恶意代码的沙箱。
- [ ] blob/manifest 完整写入、fsync 文件及目录并原子发布，再在 SQLite 事务登记固定摘要和可评审状态；以稳定 deliveryId 对账崩溃，重复同内容复用、不同内容冲突。取回缺文件、摘要不符或发布未完成保持 `retrieving`/`error`，不能通知可评审。
- [ ] 运行 `pnpm exec vitest run tests/delivery-snapshot.spec.ts tests/delivery-store.spec.ts`，覆盖故障注入、冲突、越界、并发修改和内容篡改；本地提交 `feat: persist immutable delivery artifacts`。

### Task 8: 版本化评审与可选检查

**Files:** Create `src/delivery/review.ts`, `src/delivery/checks.ts`, `tests/delivery-review.spec.ts`; modify `src/core/model.ts`, `src/core/assignments.ts`, `src/core/tickets.ts`, `src/core/stage.ts`, `src/core/engine.ts`, `src/executor/paseo.ts`, `docs/007-architecture.md`.

**Interfaces:** `recordDisposition(input: Disposition): Promise<void>`；`recordCheck(input: {delivery: DeliveryRef; argv: readonly string[]; cwd: string; exitCode: number | null; logPath: string}): Promise<void>`。

- [ ] 测试 local ticket 的 worker ready 与 PR/thread 结束路径都不能自动结束；只有完整且属于该任务的 delivery 被明确接受或明确取消才收尾。缺省 completion policy 的历史 DSH ticket 保持原 `ready` 和 followed-thread 行为。

```ts
it('does not accept a delivery because tests pass', async () => {
  await recordCheck(passingCheck('delivery-1'))
  expect((await status(taskId)).acceptedDeliveryId).toBeUndefined()
  await recordDisposition({taskId, deliveryId: 'delivery-1', outcome: 'accepted', note: 'reviewed'})
  expect((await status(taskId)).acceptedDeliveryId).toBe('delivery-1')
})
```

- [ ] 在创建 ticket 时持久固定 completion policy（本地版本化接受 / legacy），在 `Assignments.report` 和 followed-thread 终结入口统一执行策略。显式接受检查 taskId、assignmentId、完整 deliveryId；取消保留成果并展示停止未确认。返工保留同一执行实例和目录，生成新 delivery；禁止跨任务/旧实例误用。
- [ ] 同时核对 `Replies.reply`、`ticketStage` 和 `Tickets.end` 的结果呈现/终结路径：本地 worker 的 dropped、ready、PR close、重启后旧报告均不能绕过本地 completion policy；需要正式放弃时让协调者明确取消。增加 `superagent close <task> --outcome accepted --delivery <id> --note <text>` 和 cancelled 形态，CLI 不能以最新时间戳隐式选择交付；这些能力未完成前 `result` 如实显示未评审。
- [ ] 可选检查在固定交付的新副本中执行，记录 argv、cwd、运行环境描述、超时/未知退出和完整私有日志引用；不套用旧 `verifyAttempt` 强制 contract 或 SUCCEEDED。检查不能自动更改接受结论。
- [ ] 运行 `pnpm exec vitest run tests/delivery-review.spec.ts tests/core-engine.spec.ts tests/sources.spec.ts`，本地提交 `feat: review explicit delivery versions`。

### Task 9: 停止、归档和生命周期事实

**Files:** Modify `src/executor/paseo.ts`, `src/paseo/client.ts`, `src/local/read.ts`, `src/cli/superagent.ts`, `tests/paseo-executor.spec.ts`; create `tests/local-stop.spec.ts`; update `docs/007-architecture.md`.

**Interfaces:** `stop(taskId: string): Promise<StopView>`；`StopView` 各项独立保存，`stableStopped` 可为 `unknown`，`unknownChildren` 始终如实呈现。

- [ ] 测试 timeout、前缀/`--all`、cwd 冲突、重启后未确认发送、消息可能迟到、idle 但 activeTurn 非空、进程观察失败；这些都不得误称稳定停止或删除成果。

```ts
it('does not treat idle after a send as a confirmed stable stop', async () => {
  await launchAndSend(taskId)
  paseo.interrupt.mockResolvedValue({requestSent: true, runtime: idleSnapshot()})
  expect(await stop(taskId)).toMatchObject({request: 'sent', runtime: 'idle', stableStopped: 'unknown', unknownChildren: true})
})
```

- [ ] 先持久化停止意图并停止新派送；仅向已核实完整 ID 且冻结 cwd 匹配的 Paseo 会话发真正中断，保存请求结果和新鲜观测。若没有经过验证的队列栅栏，任何已发消息都使稳定停止为 unknown；不得通过重复中断或删除 worktree 假装停止成功。
- [ ] 模型输入和后台任务都无工具级沙箱隔离承诺。暂停本地主机只暂停派发/通知，不能声称 worker 已停止；`service stop`、任务 `stop` 与任务 `close` 分别显示。对于已确定在外部发送之前发生的失败可重试本地准备；一旦写请求可能已经送出就必须对账。初次 IPC 失败的用户 CLI 自动打印或持久保存 requestId，重试复用，禁止丢失身份后自动生成新请求。
- [ ] 归档是明确的逻辑操作，接受须指定完整 delivery，取消要显示停止风险；不删除 worktree 或交付。运行 `pnpm exec vitest run tests/local-stop.spec.ts tests/paseo-executor.spec.ts tests/paseo-client.spec.ts`，本地提交 `feat: report conservative stop and close states`。

### Task 10: 故障闭环、真实演示与指南

**Files:** Create `tests/local-end-to-end.spec.ts`, `scripts/local-paseo-demo.ts`, `docs/local-usage.md`; modify `PASEO.md`, `README.md`, `docs/007-architecture.md`.

**Interfaces:** `scripts/local-paseo-demo.ts --config <absolute-private-json> --run-demo`；无两项参数时只打印使用方法并退出，不创建会话或目录。配置显式包含 loopback daemon、已授权 provider/mode、专用空演示根和私有证据目录；拒绝工作仓库和既有 session ID。

- [ ] 在模拟 Paseo 端完成代码 + 非代码任务、主会话回合结束后的问题和处置、delivery1 返工到 delivery2、进程在 intent/ACK/通知时重启、无 GitHub 凭据启动；断言原始成果与不同事实分离。

```ts
it('keeps both revisions and accepts only the reviewed one', async () => {
  const {first, second} = await runAndRework()
  expect((await result(taskId, first.deliveryId)).available).toBe(true)
  expect((await result(taskId, second.deliveryId)).accepted).toBe(true)
  expect((await result(taskId, first.deliveryId)).accepted).toBe(false)
})
```

- [ ] 先运行 `pnpm check`；应通过 typecheck、全部 Vitest、build 和文档完整性。任何失败先修复，不以旧回归替代新路径。
- [ ] 在专用演示环境运行上述脚本，保存去敏的任务/执行/消息/交付 ID、观察时间、每项结果；只创建并操作带运行随机标识的新会话。按 spec 第 8 节分别验证代码、非代码、自动反馈、返工、故障恢复和中断；实际后端缺能力时报告 unknown/阻塞，不构造假成功。无可用演示配置则完成自动化并如实标记真实验收未通过，不碰用户现有会话。
- [ ] 更新 `PASEO.md` 及 `docs/local-usage.md`：一次性配置、显式服务启动、CLI 示例、当前 provider 能力、信任边界、恢复和停止未知；只有真实演示通过后才能称闭环可用。运行 `pnpm check`，精确暂存并本地提交 `docs: document and verify local workflow`。

## 顺序与交付门槛

执行顺序为 Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10。Task 6 先用显式阻止最终报告的现有策略测试派发和问题流；Task 7/8 完成交付后再测试全闭环。实现时按任务顺序推进，遇到接口变化先同步计划、调用方和测试。执行中发现 Paseo 公共能力无法证明读取或队列栅栏时，保留 unknown 并继续不依赖该能力的工作；不能把未证明能力改成成功。只有 Task 10 的真实演示达到 spec 第 8 节，才交付为本地可用版本。

## 设计覆盖自检

| Spec 范围 | 任务与验证 |
| --- | --- |
| 本地宿主、原 DSH 保留、单一事实源 | Task 1 的锁/迁移/只读测试、Task 10 原路径回归 |
| CLI 与专用 Paseo 对话、一个协调者 | Task 2 角色入口；Task 6 初始化、消息来源、route 与通知测试 |
| 固定目标与原始上下文、并行目录 | Task 3 的固定输入与来源映射；Task 4 并发槽位 |
| 反馈原始内容、早到、重放和已读边界 | Task 5 持久 outbox/连续 ACK/读取见证；Task 6 显式处置 |
| 代码/非代码交付、多版评审返工 | Task 7 原始成果与持久发布；Task 8 completion policy/可选检查 |
| 实际中断、未知状态、归档保留 | Task 9 stop/close/service 生命周期区分与 Task 10 演示 |
| 六项真实体验及无外部凭据 | Task 10 专用环境逐项记录；未通过项不得隐藏 |

计划阶段只修改设计认可状态与本文，没有执行上述产品代码、安装服务、创建会话或推送。实施前由用户审阅本计划；收到执行指令后，按正常本地开发流程推进，不默认向 Paseo 派发整份计划。
