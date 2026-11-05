# 必需会话接入点盘点

本地 Source/Channel 已验证，下面记录下一步实际需要适配的 DSH 依赖。没有引入新的领域模型或通用 runtime 框架。

| 现有位置 | DSH 依赖 | Paseo 接入时的最小处理 |
| --- | --- | --- |
| `app/sessions.ts` ensure | sessionController 创建/恢复、workspace、角色模型、preset、权限 | 适配会话创建/找回，保存逻辑会话与 Paseo agent ID 绑定；先保留 DSH 实现 |
| `app/sessions.ts` decorate | prompt section、技能注册、tools.register/restrict/guard | 复用 Prompts 输出及现有 Tool 的 schema/execute，单独适配工具暴露方式；不能只创建 Paseo 会话 |
| `app/delivery.ts` | DSH 消息源、inbox、history、flush、queue/steer/inject | 保留稳定消息身份及写入前核验；Paseo send/对账适配，普通消息不能假装静默 inject |
| `executor/dsh.ts` launch/deliver | ensure 返回 Agent、inbox.remove、pending 输入重放 | 收窄为具体会话操作；Paseo 不支持 inbox 删除时明确拒绝该等价能力，不能伪造成功 |
| `executor/dsh.ts` install | inbox claimed、user/message、agent/status/error | 只有实际消费证据才能标记 inputsRead；timeline 出现消息只证明持久/排队 |
| `executor/background.ts` 与 workerIdle | jobs、subagents、whenIdle、取消、30 分钟后台等待 | 保留 DSH 分支；Paseo 的 idle 不证明后台任务静止，记录能力差异 |
| `app/assessment.ts` | deliver 已是回调；image read 仍收 Agent | 文本候选无需改领域逻辑；图片附件按所选 provider 的能力另接 |
| `app/tools/main.ts` | Agent 用于图片评估与 preview key，Context 用于日志 | 原路由/回复/读取逻辑可复用；把会话身份与图片能力分开，避免伪造 Agent 对象 |
| `app/tools/executor.ts` | report/ack/read 操作及 relay；PR 工具依赖 GitHub | 调用原工具；Paseo 报告在绑定 ticket/assignment 的事务中核验，早到报告需持久排队 |
| `app/resources.ts` | sessionController.inspect 的 DSH events、modelCatalog | 为 transcript 和目录读取提供窄回调；保留分页、资源作用域和 prompt 版本见证 |
| `app/settings.ts`、`app/role-models.ts` | DSH 模型校验、prompt notice | DSH 原路保留；Paseo 模型选项由所选 provider 验证，不改 Policy |
| `app/runtime.ts` shutdown | 直接取消 DSH agents、后台任务和 flush | 委托实际会话实现；中断请求、idle 观察、全部子进程退出分别报告 |

## 已有 Paseo 代码可复用范围

`paseo/client.ts` 具备 create/send、按 label 找回、分页查消息、观察、精确 ID 中断和归档。当前安装的 `@getpaseo/client` 0.8.0 类型还提供 `systemPrompt`、`toolPolicy`、`mcpServers`，适合承载原提示词和一个窄工具桥；类型声明不代表所选 provider 已经通过实测。

`paseo-control/journal.ts` 可用于写前意图和未知结果对账。当前 `executor/paseo.ts` 仍限制创建参数且拒绝 ready/dropped，不可直接挂上当成等价替换；其行为必须与本轮保留的官方完成语义对齐。

## 实施顺序

1. 从现有调用处提取工具/资源和会话投递所需窄接口，DSH 先经过接口，回归行为不变。
2. 接 Paseo 协调者的候选输入、原路由工具和本地回复，再接 worker 创建、原报告工具和追问。操作员 socket 与 agent 工具桥保持不同入口；后者只允许绑定角色/任务操作。
3. 复用同一 A/B 演练任务对照结果，补重启、早到报告和中断观测。缺失的 inbox、静默通知、消费见证和后台 job 能力逐项标明；不以修改 Engine 完成语义消除差异。

## 首批提取进度

已把 `mainTools` 的 Agent 入参改为会话 ID 和可选图片读取回调；`MasterAssessor` 的文本读取不再需要构造 DSH Agent，缺失图片能力明确拒绝。`ResourceHost` 的 transcript/modelCatalog 改为窄回调，DSH 在 Runtime 中供应实现。transcript 投影保留原事件下标，保证既有 message 资源链接不变。

这些改动不改变工具名称、参数、Engine 调用或完成规则。会话创建/投递/生命周期端口和 Paseo 接线仍待实施；工具桥不能据此宣称已经可用。
