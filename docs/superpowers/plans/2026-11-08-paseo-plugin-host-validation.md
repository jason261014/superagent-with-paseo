# Paseo 插件宿主：实现、审查与验收记录

日期：2026-11-08。仓库：`/Users/anxiaojie/src/superagent-with-paseo`，分支：`codex/paseo-integration`。

## 结论

当前本机实例已由 **Paseo 的 `superagent` 插件直接托管**。日常只需 Paseo daemon 在线，在原 Superagent 对话里发消息；不再需要对应的 DSH 终端进程。原状态目录、前台对话、协调者及历史 worker 绑定继续使用，GitHub/飞书 watcher 保持关闭。

本轮没有新建项目、推送代码或创建新 PR，没有改写 `src/core` 的业务状态机，没有升级仓库的 Paseo SDK。改动仍在原工作树，包含此前已有的 worker parent/workspace 改动与项目导读。

- [设计](../specs/2026-11-08-paseo-plugin-host-design.md)
- [实现计划与完成清单](2026-11-08-paseo-plugin-host.md)
- [日常使用与回滚](../../local-usage.md)

## 1. 交付边界

| 范围 | 实际交付 |
| --- | --- |
| 共同应用 | `Runtime` 改为接收窄宿主接口的普通类；原 Engine、Policy、Ticket、Effects、Outbox、SQLite 和 IPC 不重建 |
| 旧 DSH 入口 | `src/hosts/dsh.ts` 负责 Cordis 服务注册、原生执行后端和清理；原 profile 可继续回滚使用 |
| 新 Paseo 入口 | `src/hosts/paseo.ts` 构建为 `lib/paseo-host.js`，在已有插件子进程内加载，不再启动 DSH 或第三个长期 host 进程 |
| 插件生命周期 | contribution 同步注册 provider，后台启动唯一宿主；聊天连接关闭不停止宿主 |
| 启停和恢复 | 停机先冻结派工并取消工作；等待预算耗尽不提前关库/解锁；保留原 30 秒 stale-lock 协议与 create/send/report 对账 |
| 资源与命令 | 显式 Node/MCP/ESM 路径；普通 Node runner 保留凭据过滤、有界输出、取消及真实退出等待 |
| 观测 | provider 显示 starting/needs_setup/error；原 local status 字段不变；`paseo-host-lifecycle` 只做宿主诊断，不改变 Ticket schema |

`quiesce()` 是相对计划接口示例的小补充：让后端提前取消连接与工具工作，最终 `stop()` 仍在相关调用收敛后执行。setup 改动需要重启时提示重载插件，不在旧实例尚持锁时启动继任者。

## 2. 环境与自动化结果

| 项目 | 实测值 |
| --- | --- |
| 生产 Paseo daemon | `0.15.2`，`127.0.0.1:6767`，未在本轮重启/升级 |
| 独立重启验收 daemon | `0.15.3`，`127.0.0.1:60908`；来自本机现有应用，使用独立 home，验收后已停止 |
| 仓库 SDK | `@getpaseo/plugin@0.14.0`、`@getpaseo/client@0.8.0`，锁文件未变 |
| 终端 / 显式 MCP Node | `24.13.0`；设计时已核对 Paseo Helper Node `24.20.0` 与内置 SQLite |
| pnpm | `11.7.0` |
| 真实任务模型 | 协调者和 worker 均沿用 `claude-pool/friday-deepseek-v4-flash`，mode `auto` |
| 最终全量检查 | `pnpm check`：typecheck、**75 个测试文件 / 1299 项测试**、全部构建通过 |
| 差异检查 | `git diff --check` 通过 |

全量日志：`/tmp/superagent-host-completion-check.log`。构建仍输出上游工具对 zod CJS 类型声明的警告及 Node SQLite experimental 提示；退出码为 0，类型检查与真实插件加载通过。没有把这些提示写成零告警构建。

### 重点证据

| 验收项 | 覆盖与结果 |
| --- | --- |
| DSH 导入边界 | `host-boundaries` 检查普通配置/共享函数；`host-build` 读取真实 bundler 模块图，确认宿主所有可达 chunk 不含 DSH 值模块 |
| 构建产物独立运行 | 子进程从系统临时目录加载产物，loader 拒绝任何 `@deepseek-ai/*` 解析；空状态进入 needs_setup，停止释放锁，重开保留 masterId |
| 命令 runner | `worker-command` 验证凭据过滤、显式 env、无 shell argv、退出码、输出上限和实际子进程取消 |
| 双宿主/停机期限 | `host-lifecycle` 用真实子进程阻塞 effect；stop 返回 deadline 后第二实例仍拿不到锁；旧写入完成后才交接 |
| 启动中 cleanup | `paseo-host` / `paseo-plugin-host` 验证 import、preflight、锁等待期间取消，不能在 cleanup 后又启动 Runtime |
| 客户端与 IPC 清理 | `paseo-client` 验证取消 pending connect、关闭后不重连；`local-transport` 验证 socket 关闭后仍等待已进入的异步 handler |
| 不明 create/send | `paseo-executor` / `paseo-control-journal` 关闭并重开同一 SQLite，对账已创建 agent/已投递消息；unknown/证据不足时不盲目重发 |
| report 与原工具 | Runtime 集成测试覆盖早到报告缓存、旧 assignment 拒绝、回执幂等、原角色工具限制、原绑定恢复 |
| provider 状态 | 不可用的五种宿主阶段拒绝新输入，不提前保存/宣称接单；ready 后可继续原输入；关闭连接不调用宿主 stop |
| 兼容入口 | 真实 Cordis Context 的服务注册/卸载测试，加原生 DSH 全量回归及本机 external 回滚演练 |

这些是自动化/协议层证据，不等同于每种桌面窗口动作都已手工测试。

## 3. 审查中闭环的问题

1. **共享函数仍绕回 DSH executor。** 最后一轮产物审查发现 resources/notices/cards/links/views 等模块仍从旧 executor re-export 导入，导致构建 chunk 含有 `src/executor/dsh.ts`，即使拒绝外部 DSH 包的 loader 能通过。新增 `tests/host-build.spec.ts` 首次明确复现失败，然后把这些导入改到 `executor/shared.ts`。现在真实模块图与 loader 两层检查均通过。没有通过隐藏该模块或放宽断言消除失败。
2. **Paseo 二次编译与 shared 配置边界。** shared 配置中的跨 server 类型查询会被 Paseo 编译器拒绝。现保持 shared 纯数据，把源码类型关联放进 `paseo-plugin/generated.d.ts`，入口纳入 typecheck；真实插件安装/重载通过。
3. **清理完成不能只看客户端 socket。** 私有 transport 跟踪已进入的 async handler，close 等它们结束；新增断开客户端仍等待 handler 的回归测试，防止数据库在迟到工具回调之前关闭。
4. **启动/停止与连接取消。** cleanup 标志、宿主 cancellation、SDK close 和实际 effects drain 一起约束所有权；以真实跨进程写入及 pending-connect 测试覆盖，而非仅对超时 Promise 做单测。
5. **使用说明易混淆两条路径。** 文档明确 embedded 是日常路径、external 是兼容回滚；修正 DSH-only 配置描述和 operator/worker socket 的说明。
6. **DSH 兼容路径的模型目录分流。** 抽取接口后误将 DSH 模型目录暴露给了 Paseo 协调者。补测试复现并恢复原行为：Paseo 模型工具明确提示从宿主配置选择，旧 DSH 面板的模型目录仍由 DSH 提供。

最终按计划的启动取消、独占锁、不明外部操作、资源位置、多连接五类风险复查。当前没有已确认但未闭环的阻塞性缺陷；下面的限制仍明确保留，不能解释为任意故障下的严格 exactly-once 或自动高可用。

## 4. 真实隔离任务

使用独立 plugin id `superagent-host-check`、独立 stateDir，仅复制所需部署/Policy，不复用生产 agent 身份与任务。

- A/B 任务：在真实 provider 对话中请求先问 A/B；等待回答期间 reload 插件，恢复后回复 A。
- 接单、问题和最终回复回到同一对话；Ticket 正常 `ready → completed`。
- 实际读取结果文件，内容为单字节 `A`；worker parent 指向该验证实例的 orchestrator，并处于同一 workspace。
- 两个真实 provider 连接同时使用同一控制面；关闭第一个连接后第二个仍可操作，宿主不退出。
- 第二个只读任务运行期间，仅终止验证插件的确切子进程。reload 后等待旧锁过期（该次约 27 秒），恢复并完成只读检查，没有新建重复 Ticket。
- 发生插件进程错误后，旧前台连接需 reload/reopen 才重新呈现恢复后的结果；没有通过重发任务解决。
- 两个验收 Ticket 都已完成，effect 队列为空。验证插件已移除，专用前台/协调者/worker 已归档，原生产 workspace 不受清理影响。

保留状态：`/var/folders/5f/r9s87s216j3865hp4fx4w7_c0000gn/T/sa-host-pilot-i8pLU1`。该临时目录仅是验收证据，不是日常实例。

## 5. 当前实例迁移与回滚

### 保持不变的身份

| 项目 | 值 |
| --- | --- |
| stateDir | `/Users/anxiaojie/.dsh/state/sa-paseo-check` |
| masterId | `orchestrator-efc2d6050ec8160c2fa4446c1b7f316f` |
| 前台 conversationId | `126faa6efa2b63c7486002e1537164d7` |
| Paseo orchestrator agent | `060b0ae7-ceff-4788-9593-fd470e0a47b8` |
| orchestrator workspace | `wks_80e6e75f3827cf08` |
| 桌面核查的原前台 agent | `96e92459-afb9-4cca-a475-aeba4462ae4e` |

切换前确认没有活跃用户任务，精确停止对应 DSH 进程，等待锁释放后取得完整私有备份：

`/Users/anxiaojie/.dsh/state/sa-paseo-check.before-paseo-host.20261108T083237828Z`

同一插件切为 embedded，使用同一数据库和原模型权限。6 个历史 Ticket 的结束记录与 7 个既有 agent 绑定一致；没有重建原协调者或改写旧 agent 冻结配置。

切换后在原前台对话做一次只读任务，读取本仓库 package.json，得到 `name = dsh-superagent`、`version = 0.1.0`，结果经 Outbox 回原对话。该任务 ID 为 `c36216815a24e251903d90b304ebd2ce`，worker `264a2edc-3fa7-46f3-9c2d-ffa037aa4135` 的 parent/workspace 符合现有分组逻辑。此后共 7 个 Ticket，全部结束，effect 队列为空。

另完成 **embedded → external → embedded** 的真实回滚往返：每次先停止旧宿主、等待锁释放，external 用原 DSH profile 启动并确认 accepting，再按相反顺序回 embedded。没有使用旧备份覆盖切换后的数据。

最后构建边界修正后再次 reload 生产插件，继续核对原绑定、历史 Ticket 和入口状态。最终插件 running、local status 为 configured/accepting、paused=false，无本实例对应 DSH 进程。

### 桌面确认

通过 Paseo 桌面实际查看原前台对话，历史、只读验收请求、确认和最终结果均可见；协调者所在 workspace 显示“4 个 subagent”。任务输入主要通过真实 CLI/SDK provider 协议完成，没有声称全程手工在桌面发送每条消息。

## 6. 独立 daemon 重启

为避免中断用户其他任务，未重启生产 daemon。另建 `/tmp/sa-daemon-restart-07N6mP`，使用独立 home、独立端口 `60908`、relay 关闭、插件 `superagent-daemon-check`。

该实例没有复制生产 GitHub 配置、绑定或模型授权，预期为 needs_setup：

1. 插件运行，local status 为 configured=false / accepting=false。
2. `paseo daemon restart --host 127.0.0.1:60908 --timeout 30 --json` 成功。
3. daemon worker PID 从 `1632` 变为 `12518`；host runId 改变，masterId 保持 `orchestrator-2f822af1e1db62cf148e1e94b56207ec`。
4. 重启后插件仍 running，仍处于预期的未配置状态。
5. 停止该独立 daemon 后，supervisor/worker 均退出，锁释放，lifecycle=stopped。

这是 **v0.15.3 空配置实例的生命周期重启证据**，不是生产 v0.15.2 在活跃模型任务中重启的证据。活跃任务恢复由前述 v0.15.2 插件重载/崩溃演练覆盖。

## 7. 已知限制与非目标

- Paseo daemon 仍必须在线；插件崩溃不承诺自动重启，旧对话可能需手动 reload/reopen。
- 停止等待超时不代表任务已停止；未知后台 jobs/subagents、Paseo idle、队列中未确认消息的限制与原 adapter 一致。
- 全新状态仍需原型的 GitHub repository/agent CLI setup；本轮没有增加无 GitHub 初始化或新的管理面板。
- provider 仍只收纯文本；模型、权限模式、worker 行为和 `ready` 完成语义不因换宿主而升级。
- 模型/桥配置更改只作用于新 agent，旧 agent 冻结配置不被自动重写。
- 尚未验证所有桌面多窗口/空闲回收组合、其他操作系统、Node 22 真实运行、生产 daemon 全停全启中的活跃外部写操作。测试覆盖不能冒充这些实测。
- 这是本地 prototype，不是市场分发包、通用多租户服务或任意故障下的严格一次外部执行保证。

## 8. 本地证据索引

以下在仓库忽略的 `.artifacts/paseo-host-pilot/` 下保留，不写入凭据或完整 tool grant：

| 文件 | 内容 |
| --- | --- |
| `metadata.json`、`before-reload.json`、`worker-inspect.json` | 隔离任务、重载前状态和 parent/workspace |
| `crash-check.json`、`pilot-final.json` | 精确测试进程、两个完成 Ticket、实际结果文件和空 effect 队列 |
| `production-before.json`、`production-after.json`、`migration.json` | 迁移身份比对、备份位置 |
| `production-smoke.json`、`production-ui.json` | 真实只读任务、原 UI 绑定、worker 分组和回复 |
| `production-rollback.json`、`production-final.json`、`completion-state.json` | 回滚就绪状态与最终身份/运行核查 |
| `cleanup.json` | 专用验收 agent 归档/清理 |
| `daemon-restart.json` | 独立 daemon 重启前后、版本及停机锁释放 |
| `built-host.json` | 独立产物在其他 cwd 的启动/停止证据；完整模块边界以最新 `host-build` 测试为准 |

当前日常入口仍是原来的 Superagent 对话。需要诊断时运行使用指南里的 `plugin ls/logs` 与 `superagent-local status`；不要为了修复界面重发已接收的任务，也不要强删状态锁。
