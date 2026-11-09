# Paseo 多项目 Runtime 验收记录

日期：2026-11-09。仓库 `/Users/anxiaojie/src/superagent-with-paseo`，分支 `codex/paseo-integration`。

## 交付结果

一个 `superagent` 插件/provider 现在可以按项目管理独立 Runtime 子进程。各项目使用独立状态、命令环境、对话、协调者和工具授权；管理器只保存运行意图，不打开项目 SQLite，不增加 LLM 层。

当前日常配置为 managed，原实例登记为 `legacy`，显示名 oss-explore，实际仓库 `jason261014/oss-explore`，root 为 `/Users/anxiaojie/src/oss-explore`。继续使用原状态 `/Users/anxiaojie/.dsh/state/sa-paseo-check`，原会话可直接使用。其他 clone/worktree 不自动归入 legacy；需要明确登记 root/aliases。

本轮不启用外部 watcher、不修改桌面退出设置、不重启日常 daemon、不提交或推送代码。已有 flow-web 和 worker 分组改动保留。

- [已确认规格](../specs/2026-11-09-paseo-multi-project-runtime-design.md)
- [实现计划](2026-11-09-paseo-multi-project-runtime.md)
- [使用说明](../../local-usage.md)

## 自动化与构建

最终 `pnpm check` 通过：**84 个测试文件，1334 项测试**，包括 typecheck 和全部构建。日志 `/tmp/superagent-multi-check.log`。

新增/扩充覆盖：

| 范围 | 证据 |
| --- | --- |
| 项目登记 | 真实路径、symlink、组件边界、最长根目录、disabled 子项目、重复 root/state/id/端口 |
| 进程隔离 | 两个真实 Node 子进程使用各自 PATH/git 配置，父进程环境不变 |
| 有界退出 | 启动期间 stop、阻塞清理期限、重复 init、父进程 SIGKILL 后 IPC disconnect、实际 close |
| 输出约束 | 大量子进程输出有界，当前日志最多 1MiB，保留一份轮转，文件权限私有 |
| 运行意图 | 同项目并发需求合并、手动停止、重启恢复、未使用项目、被取消的 restart、单项目崩溃隔离 |
| 管理器所有权 | 第二管理器锁等待可取消；坏意图文件不覆盖；多个子进程 shutdown 共用一次预算 |
| 路由与 persistence | 同消息 ID 不串项目、v2 固定项目、v1 legacy 升级、跨项目 binding 拒绝、迟到打开不泄漏连接 |
| 不可用入口 | starting/needs_setup 不提前保存输入或宣称已接单，手动停止不被 ensure 撤销 |
| 管理 IPC/CLI | owner-only socket、list 不启动、未知项目、坏 POST、拒绝提交宿主配置 |
| 双应用集成 | 真实 child/Runtime/SQLite/IPC/原工具桥；可控模型适配执行任务、ready 报告和原 Outbox 回传 |
| 原功能 | DSH、external、embedded、原 Policy/Ticket 语义、flow-web 及旧会话回归 |
| 产物边界 | 管理器/provider/child 的可达模块不带 Runtime/Store/SQLite 或 DSH 值模块；独立 host 仍可拒绝 DSH 解析启动 |

自动化中模型响应由 fixture 控制；下面的实际模型任务另有证据。构建仍有原有 zod 类型打包和 Node experimental 提示，不能描述成零告警构建。

## 两个真实项目的闭环

使用独立 daemon home `/tmp/sa-multi-pilot-P74t95/daemon`、控制端口 `127.0.0.1:59856` 和插件 `superagent-multi-check`，登记 alpha/beta/gamma 三个临时项目。relay 关闭，没有复制生产 agent 身份、grant 或 pending 输入。

模型会话通过原执行 daemon `127.0.0.1:6767` 的既有 claude-pool 配置运行，未将它的认证 token 复制到独立 daemon 配置。两个 Runtime 都沿用 `claude-pool/friday-deepseek-v4-flash` / auto，仓库/CLI 仅复用既有部署配置，watcher 关闭。

| 项目 | 前台 agent | Ticket | 验证结果 |
| --- | --- | --- | --- |
| alpha | `27b6dafa-de8c-4708-b662-add8a16c1871` | `b24abae6e5ebef6bb5d0bd908b3b7142` | 追问后收到 A，文件 `alpha:A`，结果回 alpha 对话 |
| beta | `e67bf02c-9d84-498c-96f9-94cdd156b748` | `d21c4d65d2542d0b23d8688e67d81b83` | 追问后收到 B，文件 `beta:B`，结果回 beta 对话 |

等待回答时两个结果文件均不存在。随后 reload 验收插件、重新加载两个原会话，再分别回答 A/B；masterId、conversation binding 和 Ticket ID 保持，均正常 `ready → completed`，effect 队列为空。两个实际文件分别为：

```text
/tmp/sa-multi-pilot-P74t95/alpha-state/work/alpha-isolation-check-b24abae6e5eb/result.txt
/tmp/sa-multi-pilot-P74t95/beta-state/work/beta-acceptance-check-d21c4d65d254/result.txt
```

从执行 daemon 读取实际 worker：alpha parent 为 `dab2cfa5-b7d7-4967-ab81-f90c5ebfca38`，beta parent 为 `3dd3bfa4-5aba-495b-ba3e-f5cacd635786`；cwd 分别是对应项目 root。不能用 KV 保存的基础 options 中缺少 parent 来推断 Paseo 的实际 parent；以公开 agent 观测为准。

两个项目画布分别得到不同 OS 分配端口，独立读取所属 Store。某次完成后空闲进程采样为 RSS 57648/58944 KiB，CPU 0.0%/0.1%；这是两份 Runtime 的单次样本，不含 daemon、模型 CLI/MCP 等进程，也不是固定资源承诺。

## 手动停止、daemon 重启与清理

对 beta 执行项目 stop 后，reload 原 beta 会话得到 `PROJECT_MANUALLY_STOPPED`，没有自动撤销停止。随后重启**独立控制 daemon**：

- alpha 意图 running，启动新 Runtime PID，原任务/会话身份保持。
- beta 意图 stopped，继续停止。
- gamma 意图 dormant，没有启动。
- 显式 start beta 后才重新进入 starting。

这个真实重启演练覆盖插件管理器及子进程的生命周期。模型执行 daemon 6767 持续在线；没有声称已验证整个执行 daemon 在活跃模型任务中同时退出的效果。

验收完成后，两个前台和四个协调者/worker 会话均已归档；独立 daemon 停止。管理器与 alpha/beta 的状态锁均释放，生命周期记录为 stopped。临时状态与证据保留，不作为日常实例。

## 日常实例迁移与回滚

迁移前确认 8 个已有 Ticket 均结束、effect 队列为空，冻结的 session/config 记录共 18 份。记录哈希而不输出完整配置/授权。停止原 embedded 插件并确认锁释放后备份：

`/Users/anxiaojie/.dsh/state/sa-paseo-check.before-multi-project.20261109T062814389Z`

切 managed 后原身份保持：

| 项目 | 保持的值 |
| --- | --- |
| masterId | `orchestrator-efc2d6050ec8160c2fa4446c1b7f316f` |
| conversationId | `126faa6efa2b63c7486002e1537164d7` |
| 原前台 agent | `96e92459-afb9-4cca-a475-aeba4462ae4e` |
| 状态目录 | `/Users/anxiaojie/.dsh/state/sa-paseo-check` |
| 原画布端口 | `17890` |

首次前台恢复超过 5 秒预算，返回 PROJECT_STARTING；后台继续初始化。就绪后重载原会话，历史完整，18 份旧绑定哈希和 8 个历史任务结束记录一致。没有换新会话遮盖超时。

在原对话完成一次真实只读任务 `0456b4a0dda2067c265c43b815389547`：worker 读取本仓库 package.json，回传 `name=dsh-superagent`、`version=0.1.0`。共 9 个 Ticket 均结束，effect 队列为空。新的对话 persistence 明确记录 projectId=legacy；历史 agent 的 cwd/模型/授权不被重写。

另执行 managed → embedded → managed 的真实往返，每次先停止旧宿主并确认锁释放，不以备份覆盖新数据。回滚时发现单实例原连接只认识 v1，因此新增共用 persistence schema：单实例可读同一 binding 的 v2，跨 binding 仍拒绝；managed 保持按 projectId 路由。

Paseo 在仅重载历史时可能保留原 v2 metadata，即使单实例 session.opened 使用 v1；因此验收依据是“原会话成功重载、历史和 binding 一致”，不强行要求 metadata 立刻降为 v1。单元测试另验证单实例的 v1 事件格式和错误绑定拒绝。

日常实例最终保持 managed；其余目录尚未登记，不会自动路由到 legacy。手动停止保护在隔离 beta 上真实验证，避免为同一机制额外中断日常实例。

最终核对：legacy ready/accepting，原前台重载成功，18 份旧冻结绑定和 8 个历史任务结束记录一致；共 9 个 Ticket 均结束，effect 队列为空，画布 API 返回 200。日常 daemon PID 45984 未变。摘要保存在 production-final.json。

## 验证范围与限制

- 未退出用户正在使用的整个 Paseo 桌面，也未改变 keepRunningAfterQuit。窗口/应用退出与 daemon 的关系根据 v0.15.3 源码核对；实际 daemon 生命周期在独立环境验证。
- 首版没有自动空闲回收，也没有跨项目 LLM 总调度。曾启动且未手动停止的项目保持运行。
- 独立进程和状态提供逻辑/生命周期隔离，不是多租户文件系统沙箱；同 OS 账号的程序仍拥有该账号允许的访问权限。
- 新项目仍需原型的仓库/账号 setup；登记不自动复制身份、Policy 或授权。
- stop 超时、进程退出和 Ticket 完成是不同事实。未知后台 jobs、Paseo 中未确认的消息及外部副作用仍按原 journal/回执对账，不声称任意故障下严格一次执行。
- macOS / Node 24.13.0 / Paseo daemon 0.15.3 实测；Node 22 和其他 OS 未做真实运行验收。
- 真实任务和历史核对主要经 CLI/SDK/provider 协议完成，本轮没有声称全程手工操作桌面 UI。

## 证据位置

仓库忽略目录 `.artifacts/paseo-multi-pilot/`：

- `setup.json`、`before-reload.json`、`running.json`：隔离配置、回答前状态、进程/绑定与 RSS 样本。
- `results.json`、`daemon-restart.json`：实际结果、worker parent/cwd、三种运行意图恢复。
- `cleanup-agents.json`、`cleanup.json`：专用会话归档和状态锁释放。
- `production-before.json`、`production-backup.json`、`production-managed.json`：迁移前摘要、一致备份、身份比对。
- `production-smoke.json`、`production-persistence-v2.json`、`production-rollback.json`：原对话只读任务、实际项目绑定与单实例回滚。
- `production-final.json`：最终 managed 状态、历史/绑定核对、画布 API 与日常 daemon 连续性。
- 原 embedded/managed 配置副本用于本机回滚；不包含模型服务认证 token。

使用 [本地指南](../../local-usage.md) 中的项目 CLI 诊断，不手动删除活锁，也不为恢复显示重发已接收的任务。
