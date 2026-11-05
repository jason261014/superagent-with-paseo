# Superagent with Paseo 最小适配验证计划

> 用户已确认按最小适配验证推进；不推送，不启用外部监听，不改变官方任务完成语义。

**Goal:** 在官方原型中替换消息输入输出和会话接入，验证相同任务流程。

**Architecture:** 保留 Engine、Policy、Ticket、Assignment、Subscriptions、Store、Effects、Outbox。先增加本地 Source/Channel，再梳理并抽取 DSH 会话所需端口，最后对照接入 Paseo。完整交付平台等增强保留在[后续方向](2026-11-05-superagent-local-future-enhancements.md)，不属于本轮。

## 1. 本地 Source/Channel

- [x] 扩展 `src/sources/local.ts`：保持默认关闭、当前 OS 用户身份；增加可重复的线程身份与本地 Channel。
- [x] 提供仅供可信同进程调用方使用的 `createLocalSource(store)`；通过既有 `SourceRegistry.register` 注册，调用方提供 `Engine.receive`。请求在 Store 原事务中比较身份与正文，再进入官方 Engine；同 ID 不同内容拒绝，正常重试复用持久记录。
- [x] Channel 通过既有 Outbox/Effects 投递，将完整回复持久存到既有 KV，按消息 ID 去重，不新增数据库或调度器。
- [x] 在 `tests/paseo-local-source.spec.ts` 使用真实 Policy/Engine/Store/Effects/Outbox 验证接单、提问、同线程答复、ready、原完成语义、重启读取和重复输入输出。
- [x] 类型检查、上述测试及官方相关回归通过。此步还不是用户 CLI 或已接线 DSH/Paseo 产品入口，不启动真实会话。

## 2. 官方宿主接线

- [x] 在现有 Runtime 的注册/生命周期点接入默认关闭的本地 Source。明确配置后才允许可信本机 IPC 接收；身份、消息上限和响应重试使用薄传输层，不另外设计领域协议。
- [x] 继续使用原 Sessions、DshExecutor、Prompts、工具和资源。通过现有 setup 的部分说明真实依赖，先不为了无 GitHub 凭据重组整个 Runtime。
- [x] 专用演示环境下用本地输入替代外部聊天，验证与官方路径相同的接单、问题、答复和 ready。用户现有服务不重启、不修改。

## 3. 必需会话端口

- [x] 盘点 `app/sessions.ts`、`app/delivery.ts`、`executor/dsh.ts`、`app/assessment.ts`、`app/tools` 和 `app/resources.ts` 对 DSH 的依赖。
- [x] 只为已有创建、投递、观察、工具/资源、报告回调和中断提取窄端口。先保留 DSH 实现走这些端口，并运行原测试验证行为不变。
- [x] 不能等价支持的后台作业、工具注册和读取见证列成具体能力差异，不以通用多 runtime 框架掩盖。

## 4. Paseo 适配与对照

- [x] 使用已有 `paseo/client.ts`，接主会话和执行者；工具通过受控本地桥接调用原 Engine 操作，而非复制其状态机。
- [x] 保留稳定消息身份、写前意图和不明结果对账；报告核验 assignment，启动前早到报告要持久保存再应用。
- [x] 不把 idle 当作业务完成或稳定停止；缺消息栅栏只报告请求/观测/unknown。不因限制修改官方 ready 完成语义。
- [x] 用相同专用任务对照 DSH 与 Paseo 路径，覆盖后续输入、重启与实际中断；源码测试通过不代替真实运行。

## 5. 收尾

- [x] 更新 `PASEO.md`，逐项写清本地入口、DSH/Paseo 接线和实测状态。
- [x] `pnpm check`，仅精确暂存本轮文件；本地提交，未经明确指令不推送。

在每一步中优先复用已有实现；只有实际接线证明必要的代码才新增。先完成第 1 步，再根据其结果细化第 2 步，不将后续增强提前塞回本轮。

## 本轮记录

2026-11-05：第 1、2 步已完成，含独立 DSH profile 的真实 A/B 问答、文件产出、ready 完成及重启去重。见 [验证记录](2026-11-05-local-entry-validation.md)。第 3、4 步已完成：Paseo 会话、MCP 原工具桥、assignment 报告回执、重启绑定与中断观测已实现；真实 Paseo A/B 演练生成 `paseo-smoke:A` 并以 upstream `ready → completed` 收尾。`pnpm check` 通过 1249 项测试、类型检查和构建。
