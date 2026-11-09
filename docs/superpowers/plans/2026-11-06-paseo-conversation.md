# Paseo Conversation Implementation Plan

> **For agentic workers:** Implement this plan one task at a time, run each task's tests before moving to the next, and track progress with checkbox (`- [ ]`) syntax.

**Goal:** 在 Paseo 的 Superagent 会话中发送普通文本，经过现有本地 Source/Policy 路由，并收到原 Outbox 的异步回复。

**Architecture:** 一个不调用模型的 provider 插件连接现有私有 Unix socket。每次输入对应独立 Local Trigger/thread；对话映射只负责上下文和输出投影，后台仍由原协调者和 worker 执行。

**Tech Stack:** TypeScript、Node SQLite、现有 KV/Store、Paseo provider protocol v1、Vitest、pnpm。

**Spec:** [Paseo 对话设计](../specs/2026-11-06-paseo-conversation-design.md)

## Global Constraints

- 保留 Engine、Policy、Ticket、Assignment、Subscriptions、Effects、Outbox 和 `ready → completed`。
- 一个状态目录绑定一个持续对话；每次输入使用独立 task thread，conversation ID 不进入 Trigger threads。
- 私有本机 socket、同 OS 用户信任边界；查询不启动 Host。
- 不升级现有 `@getpaseo/client@0.8.0`；插件接口以 v0.14.0 为最低验证基线，同时检查现场安装版本。
- 不启用 GitHub/飞书 watcher，不改变日常 daemon 的实验配置。
- 用户已确认设计并授权继续，按既有偏好在当前会话直接执行；不派发子 agent。

## Review Focus

- 请求响应丢失、重启和重复 clientMessageId：保留身份并对账，不重复创建任务。
- 后台结果在输入回合结束后到达：同一窗口收到消息，输入框持续可用。
- 新任务与追问共用窗口：新输入不扇出旧任务，明确追问才 attach。
- 刷新、断线和中断：恢复不漏消息、不重复消息；UI 中断不撤销已提交任务。
- 不可信角色和配置：worker 无全量聊天读取权，后台 provider 不递归选择 Superagent。

---

### Task 1: 独立 provider 能力探针

**Files:** 临时目录 `/tmp/sa-paseo-provider-probe-20261106/`；最终证据写入 `docs/superpowers/plans/2026-11-06-paseo-conversation-validation.md`。

**Interfaces:** 消费官方 provider protocol v1；产出当前 daemon 对普通输入、completed、回合外 timeline、持久化重放的实际证据。

- [x] 在独立 daemon home、独立本机端口注册仅回显的临时 provider；不接模型。
- [x] 输入一条消息，使用相同 `clientMessageId` 的 user_message 和 completed prompt_result，随后延迟追加 assistant_message。
- [x] 读取真实 timeline，刷新会话、重启测试 daemon，核对稳定消息 ID 和离线消息恢复；检查 native Stop 和空 catalog。
- [x] 记录通过项和限制，停止探针后再进入正式接线。见 [验证记录](2026-11-06-paseo-conversation-validation.md)。

### Task 2: 持久对话映射与事件投影

**Files:** Create `src/local/conversation.ts`, `src/local/protocol.ts`, `tests/local-conversation.spec.ts`; Modify `src/sources/local.ts`, `src/kv.ts`。

**Interfaces:** `LocalConversation` 提供 `bind()`, `binding()`, `receive(input, receiveLocal)`, `receipt(requestId)`, `events(after, through?)`, `recordReply(message)`；协议包含 Binding、Receipt、ConversationEvent、EventPage 和共享 `conversationRequestId(binding, clientMessageId)`。

- [x] 用真实 Store 测试重复、冲突、独立 thread、事务回滚和重开数据库。
- [x] 使用 KV 保存 binding、receipt、反向 channel 映射和递增序号索引；正文引用原 Trigger/reply。
- [x] Local Channel 首次保存回复时在同一事务调用 `recordReply`；没有绑定的 CLI 回复不进入对话。
- [x] `pnpm exec vitest run tests/local-conversation.spec.ts tests/paseo-local-source.spec.ts`。

### Task 3: IPC 与协调者只读上下文

**Files:** Modify `src/local/transport.ts`, `src/app/runtime.ts`, `src/app/links.ts`, `src/app/resources.ts`, `tests/local-transport.spec.ts`; Create `tests/conversation-resources.spec.ts`。

**Interfaces:** `/paseo/binding`, `/paseo/requests`, `/paseo/requests/<requestId>`, `/paseo/events`；候选卡携带 `conversation/<id>/through/<seq>` 引用。

- [x] 严格验证输入和游标；只读请求不创建 binding，source 关闭仍能查已有状态。
- [x] Runtime 注入同一个 LocalConversation 实例；receive 沿用 receiveLocal 和 Passes。
- [x] 候选最近 Ticket 简卡从原 disposition 派生；上下文按 through 序号读取，worker 访问明确拒绝。
- [x] 覆盖错误绑定、错误游标、分页、响应上限、后续输入不可见、无执行副作用。
- [x] `tests/local-conversation.spec.ts`, `tests/runtime.spec.ts` and related transport/resource coverage pass; no separate `conversation-resources.spec.ts` was needed.

### Task 4: 正式 Paseo provider

**Files:** Create `src/paseo-ui/provider.ts`, `src/paseo-ui/connection.ts`, `paseo-plugin/paseo-plugin.json`, `paseo-plugin/index.server.ts`, `tests/paseo-ui.spec.ts`; Modify build/typecheck configuration and `.gitignore`。

**Interfaces:** provider ID `superagent`，读取配置的绝对 stateDir；消费 Task 3 IPC；输出 protocol v1 原生消息及 persistence。

- [x] 创建短输入回合，接收成功才 completed；持久待确认输入、相同身份对账、正文冲突拒绝。
- [x] 有界分页轮询，固定历史上界重放；消息 ID 从原 Trigger/Outbox 派生；断线退避。
- [x] 不声明 steer/image/revert/工具权限等未实现能力；拒绝附件，关闭连接只停止自身轮询。
- [x] `can_stop_runtime` 对活动入口 veto；`interrupt` 只终止前台等待，已提交请求继续对账。
- [x] 用 mock IPC 检验断线、重复、并发、延迟结果、close 和错误事件；用真实测试 daemon 重做核心协议验证。

### Task 5: 路由闭环、回归和本机使用

**Files:** Modify `src/index.ts` 或现有配置定义、`tests/runtime.spec.ts`, `docs/local-usage.md`, `PASEO.md`; Create validation evidence document。

**Interfaces:** 后台 Paseo 角色不能配置 provider `superagent`；用户从前台 provider 提交，原协调者完成 accept/attach/stop/reply。

- [x] 用真实 Runtime 和模拟模型验证一个窗口的任务 A、任务 B、明确追问及停止，不改核心订阅规则。
- [x] `pnpm check` 和 `git diff --check`；失败时修正关联实现，不扩大重构范围。
- [x] 在专用 DSH 状态和 Paseo 测试环境做真实 A/B 文件任务，验证结果、恢复和新任务分流；停止测试进程，保留证据。
- [x] 更新安装/选择 Superagent provider 的准确步骤和限制；本地提交可审阅变更。
