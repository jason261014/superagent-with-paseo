# Paseo Multi-project Runtime Implementation Plan

> **For agentic workers:** Implement this plan one task at a time, run each task's tests before moving to the next, and track progress with checkbox (`- [ ]`) syntax.

**Goal:** 一个 Paseo 插件按项目管理独立 Superagent Runtime 子进程，保留原对话和业务状态，并在 daemon 停机、重启和项目显式停启时正确交接所有权。

**Architecture:** 插件仅维护项目登记、运行意图、provider 路由及子进程监管。每个项目继续运行现有单仓库 Runtime，独占自己的 SQLite、IPC、命令环境和协调者绑定。项目进程随 daemon 生命周期收敛，前台连接关闭不停止任务。

**Tech Stack:** 现有 TypeScript、Node.js `child_process.fork` / IPC、Unix socket、SQLite、proper-lockfile、zod、pnpm、tsdown、Vitest，以及 Paseo plugin/client SDK。

**Spec:** [2026-11-09 多项目规格](../specs/2026-11-09-paseo-multi-project-runtime-design.md)，用户已确认并授权本计划实施。六项交付已完成，见下方实施状态与 [验收记录](2026-11-09-paseo-multi-project-runtime-validation.md)。详细步骤保留实施前的检查清单，不逐字声称运行了每段示例或每种桌面动作。

## 实施状态

- [x] 任务 1：纯配置、canonical 项目登记与新 workspace，旧绑定保持。
- [x] 任务 2：独立子进程、窄 IPC、输出上限、真实退出及父进程断开测试。
- [x] 任务 3：运行意图、按需启动、手动停止、恢复与并行停机。
- [x] 任务 4：单 provider 多项目路由、v2 persistence、v1 legacy 与输入隔离。
- [x] 任务 5：managed 插件、私有管理 CLI、二次编译和构建边界。
- [x] 任务 6：双应用集成、真实 A/B 任务、独立控制 daemon 重启、原实例迁移/回滚及文档。

实现使用真实子进程覆盖部分原拟 fake process 测试，新增共用 project-persistence 模块处理回滚；手动停止的真实演练使用隔离 beta。执行 daemon 保持在线，桌面退出分支未实际强退用户应用。上述范围不冒充额外实测。

## Global Constraints

- 使用 `/Users/anxiaojie/src/superagent-with-paseo`，分支 `codex/paseo-integration`；不新建项目、不自动提交或推送。
- 保留当前单实例及 flow-web 的未提交改动；现有 lockfile 已有 flow-web 相关变更，不将它恢复到旧版本。
- 不改 `src/core` 的 Policy/Ticket/Assignment/完成语义，不新增业务数据库或全局 LLM，不升级执行 SDK。
- `@getpaseo/plugin@0.14.0`、`@getpaseo/client@0.8.0` 保持现有版本；当前 daemon 版本在真实验收时重新读取，不能沿用旧记录。
- Node 要求沿用 `package.json` 的 `^22.19.0 || >=24.0.0`；子进程使用显式 Node，不能直接拿 Electron Helper 的 process.execPath 当 Node。
- 一个 `superagent` 插件/provider；每项目一个独立 Node Runtime 子进程，一个独立 stateDir；管理器不构造 Runtime，不打开项目 SQLite。
- 进程环境变更只发生在项目子进程；保留凭据过滤、无 shell 启动、日志上限和精确进程所有权。
- GitHub/飞书 watcher 保持关闭，不修改 Paseo 的桌面退出设置，不引入独立于 daemon 的常驻服务。
- 默认按需启动；首版不自动回收空闲项目，不因关闭对话停止项目，手动停止不能被对话恢复撤销。
- 现有 `/Users/anxiaojie/.dsh/state/sa-paseo-check` 原地登记为 legacy 项目，不复制其 agent/tool grant/对话身份到其他项目。
- `session.open` 的启动等待最多 5 秒；后台宿主可按原规则等待锁最多 35 秒，stale=30 秒，不强删活锁。
- 插件 cleanup 使用一个约 1 秒总预算，并行通知所有项目；超时不等于关库、解锁或任务已终止。
- shared 配置保持纯数据，类型放独立声明文件；保留 external/embedded 单实例配置、历史 v1 persistence 和现有 flow-web。
- 所有新 `src` 模块、测试与 fixture 按当前架构表约定登记到 `docs/007-architecture.md`；每任务定向验证，最后运行 `pnpm check`、`git diff --check`。

## Review Focus

1. disabled 嵌套项目、同名前缀、symlink、alias 与重复真实 stateDir：不得通过路径匹配进入错误项目；任务 1、4 覆盖。
2. spawn/import/锁等待期间 stop、restart 或插件 cleanup，及旧 generation 的迟到状态：不得在停止后启动或同时持有两代项目进程；任务 2、3 覆盖。
3. 项目有 pending 输入或使用历史 v1 persistence，cwd 却变化、项目被禁用或绑定被伪造：不得跨项目重放、重发或默认进入 legacy；任务 4 覆盖。
4. 多项目 cleanup 超时、管理器被 SIGKILL、子进程仍持锁：不得释放旧所有权后启动继任者，不能把发送信号当作实际退出；任务 2、3、6 覆盖。
5. 手动 stopped、尚未使用和正常运行项目混合遇到 daemon restart；同时保留 legacy 的旧 agent cwd 与 flow-web 端口：任务 3、5、6 覆盖。

## 文件边界

| 文件 | 责任 |
| --- | --- |
| 新 `src/hosts/paseo-config.ts` | 从 paseo host 抽出纯数据 HostConfigSchema/HostConfig，供管理器校验而不加载 Runtime |
| 新 `src/projects/config.ts` | 项目/管理器配置 schema，旧/新插件配置选择；没有 SQLite/Runtime 值导入 |
| 新 `src/projects/registry.ts` | canonical path、目录权限、唯一状态目录、root/alias 匹配 |
| 新 `src/projects/protocol.ts` | 子进程消息、运行意图、项目快照和管理操作的普通数据契约 |
| 新 `src/projects/child.ts` | 项目 Node 入口：一次 init、动态加载宿主、状态上报、stop、父 IPC 断开 |
| 新 `src/projects/process.ts` | fork、显式解释器、过滤环境、有界日志、generation 校验和真实 close |
| 新 `src/projects/intents.ts` | 管理器锁保护下的运行意图原子文件；不存业务事实 |
| 新 `src/projects/manager.ts` | 按需启动、并发合并、操作意图、恢复与并行 shutdown |
| 新 `src/projects/management.ts`、`cli.ts` | owner-only 管理 socket 与 list/status/start/stop/restart CLI |
| 新 `src/paseo-ui/project-router.ts` | provider session→project 路由、v2 persistence 封装和 v1 升级 |
| 新 `bin/superagent-project.mjs` | 薄 CLI 包装，调用构建后的 project-cli |
| 改 `src/hosts/paseo.ts`、`src/deployment.ts`、`src/app/runtime.ts` | 复用配置、允许指定新协调者 workspaceDir；旧绑定不变 |
| 改 `src/paseo-ui/provider.ts`、插件入口与配置、构建/声明 | 接线 managed 模式；保留原单实例实现 |
| 新 `tests/fixtures/projects.ts`、`project-runtime.mjs` | 临时目录、真实构建入口和可控测试宿主；无真实模型或授权 |
| 新 `tests/project-registry.spec.ts`、`project-process.spec.ts`、`project-manager.spec.ts` | 路径、子进程/孤儿处理、运行意图与竞态 |
| 新 `tests/project-provider.spec.ts`、`project-management.spec.ts`、`projects-integration.spec.ts` | 跨项目路由、管理协议与双进程完整验证 |

不把项目路由塞进核心 Engine。`src/paseo-ui/connection.ts` 继续处理单个项目既有协议；需要修改它时仅增加必要的注入点，不复制输入幂等和回放实现。

## 共同接口与运行规则

下列接口名称供各任务共同使用。HostConfig 是配置输入类型，HostStatus/HostStop 沿用 `src/hosts/lifecycle.ts`，ConversationBinding 沿用 `src/local/protocol.ts`。

```ts
// src/projects/config.ts
export interface ProjectDefinition {
  id: string
  label: string
  root: string
  aliases?: string[]
  enabled: boolean
  hostConfig: HostConfig
}
export interface ProjectManagerConfig {
  managerDir: string
  nodeExecutable: string
  childEntry: string
  runtimeEntry: string
  legacyProjectId?: string
  projects: ProjectDefinition[]
}
export function parseProjectManagerConfig(input: unknown): ProjectManagerConfig

// src/projects/registry.ts
export interface RegisteredProject extends ProjectDefinition {
  roots: readonly string[]
}
export interface ProjectRegistry {
  list(): readonly RegisteredProject[]
  get(id: string): RegisteredProject
  match(cwd: string): RegisteredProject
}
export function createProjectRegistry(config: ProjectManagerConfig): ProjectRegistry

// src/projects/protocol.ts
export type ProjectDesired = 'dormant' | 'running' | 'stopped'
export interface ProjectSnapshot {
  id: string
  label: string
  desired: ProjectDesired
  enabled: boolean
  host: HostStatus
  generation?: string
  pid?: number
  flowWebUrl?: string
}
export interface ProjectExit { code: number | null; signal: NodeJS.Signals | null }
export type ProjectAction = 'start' | 'stop' | 'restart'
export interface ProjectActionResult {
  accepted: true
  project: ProjectSnapshot
  stopped?: HostStop
}
export type ProjectCommand =
  | { version: 1; type: 'init'; projectId: string; generation: string;
      runtimeEntry: string; config: HostConfig }
  | { version: 1; type: 'stop'; projectId: string; generation: string }
export type ProjectEvent =
  | { version: 1; type: 'status'; projectId: string; generation: string;
      status: HostStatus; flowWebUrl?: string }
  | { version: 1; type: 'stopped'; projectId: string; generation: string }

// src/projects/process.ts
export interface ProjectProcess {
  readonly pid: number | undefined
  readonly ready: Promise<HostStatus>
  readonly closed: Promise<ProjectExit>
  status(): HostStatus
  flowWebUrl(): string | undefined
  stop(budgetMs?: number): Promise<HostStop>
}
export interface ProjectProcessOptions {
  project: RegisteredProject
  generation: string
  nodeExecutable: string
  runtimeEntry: string
  childEntry: string
  logDirectory: string
}
export function spawnProjectProcess(options: ProjectProcessOptions): ProjectProcess
export type ProjectProcessFactory = (options: ProjectProcessOptions) => ProjectProcess

// src/projects/manager.ts
export interface ProjectEndpoint {
  projectId: string
  stateDir: string
  status(): HostStatus
}
export interface ProjectManager {
  readonly ready: Promise<void>
  registry: ProjectRegistry
  list(): ProjectSnapshot[]
  status(id: string): ProjectSnapshot
  ensure(id: string, budgetMs?: number): Promise<ProjectEndpoint>
  act(id: string, action: ProjectAction): Promise<ProjectActionResult>
  shutdown(budgetMs?: number): Promise<HostStop>
}
export function createProjectManager(config: ProjectManagerConfig, options?: {
  processFactory?: ProjectProcessFactory
}): ProjectManager
```

接口规则：

- `start` 的 accepted 仅代表管理操作已接受；宿主是否 ready 看 project.host，任务是否接单仍看原 durable receipt。
- `ensure()` 只在 ready 时返回 endpoint；needs_setup/error/stopped 给具体错误，starting 超过 5 秒返回启动中错误，不能通过增加等待时间掩盖冷启动。
- `ProjectProcess.ready` 在 ready 或 needs_setup 完成，致命启动错误拒绝；Promise 拒绝必须有观察者。
- `ProjectProcess.stop()` 的 closed=true 以子进程真实 close 为准，不以收到 stopped 消息或发出 SIGTERM 为准。
- manager 的 shutdown closed=true 还要求控制 socket handler 收敛、意图写入结束和管理锁释放；不能只汇总子进程状态。

## Task 1: 项目配置、目录身份与新会话 workspace

**Files:** 新配置/registry 模块和 `tests/project-registry.spec.ts`、`tests/fixtures/projects.ts`；修改 HostConfig 提取位置、Machine、Runtime 的新建协调者 cwd；扩展 `tests/paseo-host.spec.ts`、`tests/paseo-sessions.spec.ts` 和架构表。

**Consumes:** 现有 HostConfigSchema、createPaseoHost、Machine 和冻结的 Paseo 会话绑定。

**Produces:** 上述配置/registry 接口；HostConfig/Machine 的可选 `workspaceDir: string`。`paseo.ts` 保留旧的类型和 schema re-export，避免破坏调用方。

- [ ] **1. 记录当前基线。** 阅读 git diff，区分原宿主、worker 分组和 flow-web 改动；记录 `pnpm typecheck` 与以下定向测试结果。只记录摘要，不输出完整 agent 配置或 tool grant。

  ```sh
  pnpm exec vitest run tests/paseo-host.spec.ts tests/paseo-sessions.spec.ts tests/flow-web-server.spec.ts tests/docs.spec.ts
  ```

- [ ] **2. 先编写目录身份测试与临时 fixture。** `createProjectFixture(ids: string[])` 返回 `config: ProjectManagerConfig`、`root(id)`、`stateDir(id)`、`dispose()`；目录全部在同一短临时根下，host 使用 process.execPath 和本仓库 MCP 文件，不访问模型。测试至少包含：

  ```ts
  const fixture = createProjectFixture(['alpha', 'beta'])
  const registry = createProjectRegistry(fixture.config)
  expect(registry.match(join(fixture.root('alpha'), 'src')).id).toBe('alpha')
  expect(() => registry.match(fixture.root('alpha') + '-other')).toThrow('PROJECT_NOT_REGISTERED')
  ```

  match 使用现存真实目录，测试先创建 `src` 和 `alpha-other`。补 symlink alias、嵌套根最长匹配、disabled 子项目不落入父项目、同等 alias 冲突、同真实 stateDir、缺目录和非安全状态目录案例。fixture 在 finally/afterEach 清理。

- [ ] **3. 提取纯 HostConfigSchema 并验证配置。** `paseo-config.ts` 只使用 zod、path 和 LIMITS；不得值导入 Runtime、Store、paseo backend。管理器 schema strict；项目 id 用 `/^[a-z][a-z0-9-]{0,63}$/`，所有入口/目录绝对且不含 NUL，Node 可执行。端口只对已启用 flow-web 的非零端口检查唯一性，port=0 允许 OS 分配。

  ```ts
  const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
  const project = ProjectDefinitionSchema.parse(input)
  const root = realpathSync(project.root)
  const stateDir = realpathSync(project.hostConfig.stateDir)
  ```

  schema 名称在 config 模块定义并导出；registry 用真实路径检查 current UID 和状态目录不可被其他账号写入。登记不自动创建项目 root/stateDir，不复制 deployment/Policy。managerDir 可由管理器创建；不能与项目状态目录相同。managed 项目若显式指定 workspaceDir，必须属于该项目登记的 root/aliases，不能指向另一项目；缺省使用 root。

- [ ] **4. 实现按组件匹配。** root/alias 去重后存 roots；不用字符串 startsWith。候选先包含 disabled 记录，选最长 root 后再判断 enabled，避免禁用的嵌套项目被父项目接走。目录在运行后被删除/改映射时 fail closed，不重新猜远端 URL 或项目名。

  ```ts
  const relativePath = relative(root, cwd)
  const contained = relativePath === '' || (
    !isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith('..' + sep)
  )
  ```

- [ ] **5. 只改变新建协调者的 workspace 选择。** HostConfig 增加 workspaceDir，createPaseoHost 传到 Machine，Runtime 调用：

  ```ts
  await this.sessions.ensure(
    this.masterId, this.machine.workspaceDir ?? this.machine.stateDir,
    'dsh-superagent orchestrator', 'orchestrator',
  )
  ```

  管理器新项目默认 workspaceDir=登记 root；masterId 仍由原 stateDir 决定。已有 bindings/configs 不重写，worker 继续继承已绑定协调者 cwd，任务目录继续来自 DSH_SUPERAGENT_DIR。测试新建 cwd 与旧绑定不变，不修改 DSH 配置默认行为。

- [ ] **6. 定向验证并登记模块。**

  ```sh
  pnpm exec vitest run tests/project-registry.spec.ts tests/paseo-host.spec.ts tests/paseo-sessions.spec.ts tests/host-boundaries.spec.ts tests/docs.spec.ts
  pnpm typecheck
  ```

**完成标准：** 注册/路径解析不会启动宿主；项目身份唯一、配置可被管理器安全读取；旧 workspace 绑定不变。

## Task 2: 独立子进程入口与真实退出

**Files:** 新 `src/projects/protocol.ts`、`child.ts`、`process.ts`、`tests/project-process.spec.ts`、`tests/fixtures/project-runtime.mjs`；修改 tsdown entry、`tests/host-build.spec.ts` 和架构表。

**Consumes:** 任务 1 的 RegisteredProject、HostConfig；现有 createPaseoHost、workerEnvironment、HostStop。

**Produces:** ProjectCommand/Event、ProjectProcess/Options 与 spawnProjectProcess。`lib/paseo-project-child.js` 为独立 Node 入口；child 动态导入显式 runtimeEntry。

- [ ] **1. 用真实 IPC 子进程构造失败用例。** fixture `project-runtime.mjs` 导出 createPaseoHost：返回可控 ready/status/stop，写入只含 PID、PATH、GIT_CONFIG_GLOBAL 和停止标记的诊断文件；延迟/阻塞模式由 fixture 内的临时控制文件选择，不添加生产配置开关。测试加载构建后的真实 child 入口，以 fixture 文件 URL 为 runtimeEntry。

  ```ts
  const first = spawnProjectProcess(options)
  await first.ready
  const second = spawnProjectProcess(otherOptions)
  await second.ready
  expect(first.pid).not.toBe(second.pid)
  expect(process.env.PATH).toBe(parentPath)
  expect(await first.stop(1000)).toEqual({ closed: true })
  await second.stop(1000)
  ```

  另覆盖 startup 未完成即 stop、错误/重复 init、错误 generation、import 失败、状态变化、异常 close 和超出日志上限。不能仅用 EventEmitter fake 声称进程隔离通过。

- [ ] **2. 固定窄消息与配置传输。** 所有消息 zod strict 校验，包含 version/projectId/generation；只接受与该 ChildProcess 初始化身份一致的消息。init 仅一次，stop 幂等。无 IPC 的 child 启动报错退出。所有 disconnect/SIGTERM/SIGINT handler 必须在动态 import 前注册。

  ```ts
  const child = fork(options.childEntry, [], {
    execPath: options.nodeExecutable,
    execArgv: [],
    cwd: options.project.root,
    env: workerEnvironment(process.env),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
    detached: process.platform !== 'win32',
  })
  ```

  projectId/config 通过 init IPC 发送，不拼到 argv，不把 config 赋给管理器 process.env。Node 版本与 executable 的验证不能依赖传入字符串看起来像 Node。

- [ ] **3. 子进程复用现有宿主。** 动态 import 后每个 await 检查 stopping；调用 createPaseoHost 后观察 ready，报告 status/flowWebUrl。使用单个可清理、unref 的短定时器，仅在状态变化时上报，覆盖 ready 后 setup 要求重载的情况。ready/needs_setup 与插件 registered 区分。

  ```ts
  const module = await import(pathToFileURL(runtimeEntry).href)
  if (stopping) return
  host = module.createPaseoHost(config)
  await host.ready
  if (!stopping) reportStatus(host.status(), host.flowWeb?.())
  ```

- [ ] **4. 明确停止时限与强制退出。** 第一次 stop/disconnect/signal 启动同一清理，给 Runtime 1000ms 等待；再等待至从首次停止算起的 1500ms 硬退出期限。安全关闭成功才报告 stopped 并退出 0；否则非零退出，不主动删锁/调用 Store.close 绕过 Runtime。timer 不因重复信号延长。

  父进程 driver 同步开始 stop：发 IPC，1000ms 后只对仍归本 driver 的存活 child 发 SIGTERM，2000ms 后 SIGKILL；close 清所有 timer。不能根据已缓存 PID 对关闭过的进程发信号。驱动器只保证直属 Runtime 退出；未知 agent/jobs 的停止仍依赖原后端，不能承诺一并消失。

- [ ] **5. 实测父进程消失。** 测试父 fixture 再创建 Runtime child，父 fixture 被 SIGKILL 后 child 收到 IPC disconnect 并有界退出；额外阻塞清理，断言没有 stopped 成功假象。使用确切 PID/退出事件，finally 收拾自己创建的进程，禁止 pkill。

  日志以 projectId/generation 分流到 managerDir/logs；逐流处理块，行和内存缓冲不超过 64KiB，每项目当前文件最多 1MiB、保留一份轮转。错误只带类型/阶段，不回显 init config 或凭据。清理要等待相关输出/写入收敛。

- [ ] **6. 构建并验证导入边界。** 加入 lib child entry；fixture 用真实 tsdown 配置构建到 `.artifacts` 下临时目录。扩展 host-build：child 不静态加载 Runtime，管理器可达 chunk 不带 Runtime/Store/node:sqlite，独立 host 仍不带 DSH 值模块。

  ```sh
  pnpm exec vitest run tests/project-process.spec.ts tests/host-build.spec.ts tests/worker-command.spec.ts tests/host-lifecycle.spec.ts
  pnpm typecheck
  ```

**完成标准：** 两个项目进程的环境不串用，子进程不能在停止后迟到启动；closed=true 有真实 close 证据，父进程异常退出有有界处理。

## Task 3: 管理器、运行意图与并行停机

**Files:** 新 `src/projects/intents.ts`、`manager.ts`、`tests/project-manager.spec.ts`；扩充 fixtures 与架构表。

**Consumes:** 任务 1 的 registry、任务 2 的 ProjectProcessFactory。

**Produces:** 共同接口中的 createProjectManager/ProjectManager。意图文件只记录 `{ version: 1, projects: Record<string, 'running' | 'stopped'> }`；无记录即 dormant。

- [ ] **1. 用可控 processFactory 测试状态机。** fixture 中定义 fake ProjectProcess：可分别完成 ready 和 closed，记录 stop 调用，不能把 stop 被调用自动视为 closed。以真实临时 managerDir 检查：

  ```ts
  const manager = createProjectManager(config, { processFactory })
  await manager.ready
  const requests = [manager.ensure('alpha'), manager.ensure('alpha')]
  await vi.waitFor(() => expect(createdProcesses).toHaveLength(1))
  completeReady('alpha', { phase: 'ready' })
  await Promise.all(requests)
  await manager.act('alpha', 'stop')
  await expect(manager.ensure('alpha')).rejects.toThrow('PROJECT_MANUALLY_STOPPED')
  ```

  helper 的实现放 tests/fixtures/projects.ts；registry/config/driver 采用前面定义的真实接口。再覆盖不同项目同时 start、需求启动后无任务仍保持运行、单项目错误不影响其他项目、意图写入失败不 spawn，以及管理锁等待期间 cleanup。

- [ ] **2. 实现独占管理目录和原子意图存储。** managerDir 的所有者/权限与原私有 IPC 规则一致，先取得 proper-lockfile 锁再读写 intents。遇到 ELOCKED 沿用 30 秒 stale、最多 35 秒可取消等待；cleanup 取消等待，迟到取得锁也不再启动项目。使用随机临时文件、0600、文件 fsync、rename、目录 fsync；已有不安全文件、坏 JSON、未知版本报错，不静默初始化覆盖。

  ```ts
  export interface ProjectIntents {
    get(id: string): ProjectDesired
    set(id: string, desired: 'running' | 'stopped'): Promise<void>
    flush(): Promise<void>
  }
  export function openProjectIntents(managerDir: string): ProjectIntents
  ```

  同一管理器串行写入；只写入意图，不存 pid 作为跨重启信任证据。外部旧进程未消失时仍由项目 stateDir 锁阻止双写。

  初始化任一步失败时 ready 拒绝并被观察；仅在没有尚未退出的本管理器工作时释放已取得的管理锁。失败路径和 cleanup 都等待同一初始化 Promise，不因读取意图失败留下监听或晚到启动。

- [ ] **3. 定义操作顺序。** 显式 start/restart 或首次 demand 校验项目后，将 running 意图持久化，再 spawn；这是“运行请求已接受”，不是业务 ready。手动 stop 先持久化 stopped，再发停止。意图写入失败时不 spawn、不报告 accepted。demand 不得覆盖 stopped。

  每项目维护 generation、当前 Process、串行操作尾部和需求版本；停止/关闭标记在等待前设置。意图写入串行，但等待旧进程退出不能阻止后来 stop 先标记取消后继启动；写入失败只回退仍属于当前需求版本的内存意图。重启只在旧 closed 后发生，途中收到更新的 stop 或 manager shutdown 必须取消后继 spawn。所有 await 后复核 generation/关闭/期望状态。

- [ ] **4. 实现 ready/预算与按意图恢复。** 初始化仅恢复 enabled 且意图 running 的项目，彼此独立；不 await 全部项目 ready 后才注册 provider。每个失败单独 catch 到快照，不无限重试。ensure 的 5000ms 是从调用起的总等待，含 manager ready 和 child ready；超时仅结束调用者等待，不能启动第二个进程或把 starting 改为 stopped。

  ```ts
  const current = getOrStartProcess(projectId)
  const status = await waitForProjectReady(current, remainingBudgetMs)
  if (status.phase !== 'ready') throw projectUnavailable(projectId, status)
  return endpointFor(projectId)
  ```

  `getOrStartProcess`、`waitForProjectReady`、`projectUnavailable`、`endpointFor` 是 manager 内部函数，分别实现启动合并、有限等待、中文可诊断错误和只含项目 transport 路径的 endpoint。错误消息不得携带完整 HostConfig。

- [ ] **5. 实现整个管理器一次 shutdown。** 同步设置 closing、阻止新操作，通知所有项目 stop，再统一等待一次预算；不能 `for await` 逐项目等待 1000ms。shutdown 保留 running 意图，手动 stop 才改 stopped。实际 final cleanup 等待全部 closed、未完成意图写入和控制入口关闭后才释放管理锁；超过预算仍返回 closed=false。

  ```ts
  closing = true
  const stops = activeProcesses.map(process => process.stop(budgetMs))
  const finalClose = Promise.all(activeProcesses.map(process => process.closed))
  void Promise.allSettled(stops)
  return waitForHostStop(finalCleanup(finalClose), budgetMs)
  ```

  finalCleanup 必须复用唯一 Promise，不能在每次 shutdown 创建新清理；后续任务接入控制 socket 时并入同一清理。

- [ ] **6. 覆盖真实持锁和恢复。** 三个项目：running、stopped、dormant；关闭再构造同 managerDir，只恢复 running。对两个故意延迟 stop 的项目用 fake timer 验证总等待不是两个预算之和；再用真实 child 证明 stop 超时期间同目录仍不可取得所有权，旧 close 后再按锁规则启动。迟到旧 status/exit 不改变新 generation。

  ```sh
  pnpm exec vitest run tests/project-manager.spec.ts tests/project-process.spec.ts tests/host-lifecycle.spec.ts
  pnpm typecheck
  ```

**完成标准：** 没有对话就不启动未用项目；手动停止与宿主停止区分明确；管理器关闭、重启和竞争操作均不双写项目状态。

## Task 4: 持久项目绑定与 provider 多路复用

**Files:** 新 `src/paseo-ui/project-router.ts`、`tests/project-provider.spec.ts`；按需修改 provider 工厂；保留 connection/transport/pending 的核心行为，更新架构表。

**Consumes:** ProjectManager、现有 createConversationConnection/conversationTransport/pendingInputs/ConversationBinding。

**Produces:** `createProjectConversationConnection(options): ProviderConnection`，options 为 `{ capabilities: readonly string[]; manager: ProjectManager; legacyProjectId?: string }`；外层 v2 persistence schema。

- [ ] **1. 固定 v2 格式和 v1 兼容规则。** 项目 ID schema 复用配置，Binding 复用原协议。新格式仅是 provider persistence，不能写入 ConversationInput 或改变 requestId 算法。

  ```ts
  const ProjectPersistenceSchema = z.object({
    version: z.literal(2),
    data: z.object({ projectId: ProjectIdSchema, binding: ConversationBinding }).strict(),
  }).strict()
  ```

  首次打开用 registry.match(input.config.cwd)；v2 恢复用 projectId；v1 只允许 legacyProjectId，并用该项目 IPC 的现有 binding 完全匹配。不能用 cwd 猜测旧绑定，不能把缺失/禁用项目落到其他实例。

- [ ] **2. 构造真实会话协议测试。** 每个项目用独立临时 pending/transport；用现有 tests/paseo-ui.spec.ts 的 open/prompt 输入形状，测试相同 clientMessageId 下 A/B 分别得到自己的用户事件、回执和回复。测试代码至少断言：

  ```ts
  expect(openedAlpha.persistence).toMatchObject({
    version: 2, data: { projectId: 'alpha', binding: alphaBinding },
  })
  expect(alphaTransport.submit).toHaveBeenCalledWith(
    expect.objectContaining({ binding: alphaBinding, clientMessageId: 'shared-message' }),
  )
  expect(betaTransport.submit).toHaveBeenCalledWith(
    expect.objectContaining({ binding: betaBinding, clientMessageId: 'shared-message' }),
  )
  ```

  openedAlpha、alphaTransport、betaTransport 由本文件 fixture 的真实 ProviderEvent/ConversationTransport 定义，不读取项目数据库来制造“恢复成功”。

- [ ] **3. 每项目复用单项目 connection。** router 每个 provider connection 内维护 projectId→delegate 与 sessionId→projectId；为选定项目调用 manager.ensure 后创建 delegate。events 透传前将 session.opened/session.persistence 的 v1 内层 persistence 封装为 v2；恢复输入先解包，再交单项目 connection 处理。

  不复制 receipt、reconcile、readEvents、prompt 的实现。delegate 的 hostStatus 回调读取 manager.status(id).host，项目停止时拒绝新输入，pending 仍由原协议恢复。

- [ ] **4. 隔离异步打开和关闭。** session.open 期间标记该 session 正在打开；重复 open 报错。连接或 session 在 ensure 等待期间关闭，迟到返回不得创建 delegate/发 ready。项目按需启动仍可继续，不能因此停止它。interrupt/close 路由到已绑定项目，不能按新 cwd 再匹配；close 所有 delegate 仅关闭订阅，不调用 manager.shutdown/stop。

  ```ts
  const endpoint = await manager.ensure(projectId, 5000)
  if (closed || cancelledSessions.has(input.sessionId)) return
  const delegate = connectionFor(endpoint)
  sessionProjects.set(input.sessionId, projectId)
  await delegate.send(innerOpen)
  ```

- [ ] **5. 覆盖恢复与未接单语义。** v1 匹配后升级 v2；A persistence 搭配 B binding 被拒绝且不 submit；v2 A 即使 cwd 改为 B 仍归 A。启动超过 5 秒只返回 starting，needs_setup/disabled/manual_stop/error 都不 pending.put、不显示接单。一个项目断线不阻止另一个项目对话；A/B polling 与回放各自有序。

- [ ] **6. 验证单实例兼容。**

  ```sh
  pnpm exec vitest run tests/project-provider.spec.ts tests/paseo-ui.spec.ts tests/local-conversation.spec.ts tests/local-transport.spec.ts
  pnpm typecheck
  ```

**完成标准：** 单 provider 可以并行服务多个项目，旧对话精确恢复；项目内原输入幂等和回放语义保持。

## Task 5: 插件接线、管理 IPC/CLI 与打包

**Files:** 新 management/cli、bin；修改插件入口、example、generated.d.ts、package.json、tsdown、manager 的控制入口生命周期；新 `tests/project-management.spec.ts`，扩展 plugin-host/host-build 测试及架构表。

**Consumes:** registry/manager/router 接口，以及已有 listenPrivate/localCall。

**Produces:** managed 插件模式、`listenProjectManagement(manager, managerDir)` 和 `main(args?, write?)` CLI；管理 socket 固定为 `<managerDir>/local-ipc/s`。

- [ ] **1. 保留旧配置并定义 managed 分支。** 插件使用配置模块 namespace，不要求每种模式都导出不存在的字段。config 模块导出以下判别联合和解析函数，source 为纯数据、env 只读：

  ```ts
  export type PluginOptions =
    | { mode: 'external'; stateDir: string }
    | { mode: 'embedded'; stateDir: string; runtimeEntry: string; hostConfig: HostConfig }
    | { mode: 'managed'; managerConfig: ProjectManagerConfig }
  export function resolvePluginOptions(
    source: Record<string, unknown>, env: NodeJS.ProcessEnv,
  ): PluginOptions
  ```

  external/embedded 沿用旧默认与 SUPERAGENT_STATE_DIR 覆盖；managed 必须显式 hostMode='managed' 和 managerConfig，拒绝全局覆盖及非空旧 stateDir/hostConfig/runtimeEntry 混用。本步只改示例，不切换日常 local-config。

- [ ] **2. 管理器持有控制监听生命周期。** 在 manager.ready 的锁/意图初始化后调用 listenProjectManagement，保存 opening Promise。shutdown 先关闭监听、等待已进入 handler，再完成子进程/写入清理并解锁。listenPrivate 的 socket 安全校验和异步 handler drain 继续复用。

  | Method/path | 行为 |
  | --- | --- |
  | GET `/projects` | 返回安全 ProjectSnapshot 列表，不启动任何项目 |
  | GET `/projects/:id` | 单项目状态，不启动 |
  | POST `/projects/:id/start`、`stop`、`restart` | 调用 manager.act，返回 accepted 与快照；stop 可含 stopped 预算结果 |

  POST 仅接受空 JSON 对象，body 上限 1KiB；未知路径、项目和字段分别报固定错误，禁止提交 stateDir、命令或 HostConfig。长启动/restart 不阻塞 HTTP 至 ready，保留原 privateCall 10 秒请求上限。

- [ ] **3. 实现薄 CLI。** 使用 node:util parseArgs，严格检查绝对 managerDir、命令和参数数量，CLI 不自动启动 manager/daemon。stdout 输出 JSON，连接错误给出“请检查 Paseo daemon 与 Superagent 插件”，退出码非零，不伪造 empty list。

  ```text
  superagent-project --manager-dir /absolute/private/manager list
  superagent-project --manager-dir /absolute/private/manager status alpha
  superagent-project --manager-dir /absolute/private/manager start alpha
  superagent-project --manager-dir /absolute/private/manager stop alpha
  superagent-project --manager-dir /absolute/private/manager restart alpha
  ```

  bin 包装沿用 superagent-local 的 ESM main().catch 模式，package.json 增加 bin；旧 CLI 的 stateDir 路径和现有选项不变。

- [ ] **4. 同步 contribution 与短 cleanup。** managed 分支创建一个 manager，立即注册项目 provider，manager.ready 的错误可诊断且有 catch；不等待项目恢复完成才返回 cleanup。provider 工厂在 managed 分支调用 project-router，原 createSuperagentProvider 外部/embedded 调用路径不改变。

  ```ts
  const manager = createProjectManager(options.managerConfig)
  server.registerProvider(createProjectProvider({
    manager, legacyProjectId: options.managerConfig.legacyProjectId,
  }))
  return async () => {
    const result = await manager.shutdown(1000)
    if (!result.closed) console.warn('Superagent projects are still stopping')
  }
  ```

  `createProjectProvider({ manager, legacyProjectId? }): ProviderRegistration` 在 provider.ts 导出；始终注册 id='superagent'。若 registerProvider 抛错，立即请求 manager 清理，不能留下后台恢复流程。

- [ ] **5. 两次构建与边界测试。** tsdown 增加 lib child/project-cli、插件 server 的 project-manager/project-provider entries；generated.d.ts 对应源码导出。保持 shared 纯数据。host-build 从各 entry 遍历真实 bundler 模块图，断言管理器/router 可达 chunk 不包含 Runtime/Store/DSH/node:sqlite；child 只动态加载外部 runtimeEntry，host 允许 SQLite 但不加载 DSH。

  不通过关闭测试或清空 bundler modules 来“通过”边界。保留现有 flow-web UI build、静态资源路径与 bin/MCP 包资源。

- [ ] **6. 测试控制协议、旧配置和 cleanup 竞态。** 实际 Unix socket 验证错误项目、坏 body、两个管理器冲突、启动不等 ready、stop 不自动复活、disabled 配置与连接关闭不改意图；初始化 socket 尚未完成时 plugin cleanup 仍正确回收。临时 plugin 配置分别跑 external/embedded/managed 的实际 Paseo 二次编译。

  ```sh
  pnpm exec vitest run tests/project-management.spec.ts tests/project-manager.spec.ts tests/paseo-plugin-host.spec.ts tests/host-build.spec.ts tests/docs.spec.ts
  pnpm typecheck
  pnpm build
  ```

**完成标准：** 一个插件提供项目对话与管理控制；不依赖管理器打开业务数据库，旧配置继续可用，构建/真实插件加载边界成立。

## Task 6: 双项目验收、迁移与使用说明

**Files:** 新 `tests/projects-integration.spec.ts`、`docs/superpowers/plans/2026-11-09-paseo-multi-project-runtime-validation.md`；更新 local-usage、PASEO、project-overview、架构表和计划进度。通过隔离环境验证后才修改日常 local-config。

**Consumes:** 前五任务通过的全部产物、现有 standalone host 和 legacy 对话。验收记录区分自动化、真实 provider/模型、桌面与未验证项。

- [ ] **1. 自动化双进程与故障验证。** 用实际 child/manager 与短临时目录创建 A/B：PID、PATH/shim、git 配置、SQLite masterId/conversation、worker labels 分别独立。读项目 SQLite 只允许在测试/诊断中 readOnly 打开；管理器生产代码不能打开它。

  空状态的真实宿主先验证 needs_setup、独立数据库和停止释放锁。需要 ready/worker 工具的自动化组由 tests/fixtures/projects.ts 构建测试专用 ESM wrapper，调用现有 `createPaseoHost(config, { runWorker, createAdapter })` 注入可控 CLI/模型适配，按 tests/runtime.spec.ts 的部署响应和原工具流程准备独立测试状态；不向生产 HostConfig/IPC 添加测试开关。模型响应可控，但子进程、Runtime、Store、Unix socket 和原工具桥必须真实运行。

  通过实际 provider 协议发送相同 clientMessageId，验证 A/B 输入/回复不混；A pending 对账不访问 B。还需两项目 flow-web 用独立端口正常读取，显式重复端口配置失败。对宿主 import/锁等待/effect 阻塞故障使用 fixture，不随机杀用户任务。

  ```sh
  pnpm exec vitest run tests/projects-integration.spec.ts tests/project-provider.spec.ts tests/project-process.spec.ts tests/host-lifecycle.spec.ts tests/flow-web-server.spec.ts
  ```

- [ ] **2. 在独立 daemon 验证三种运行意图。** 先查当前 `paseo daemon start/config/restart` 帮助，在短临时 home 配置独立 loopback 端口、relay off、pluginsEnabled=true，不使用用户 daemon 的端口。配置隔离插件 id/provider；登记 alpha/beta/gamma，alpha 启动、beta 手动 stop、gamma 未使用。重启后只恢复 alpha；再单独重启 alpha 验证不影响其余项目。

  关键命令必须明确目标，独立 `pilotAuthority` 从本次 daemon 返回值取得：

  ```sh
  paseo daemon status --host "$pilotAuthority" --json
  paseo plugin ls --host "$pilotAuthority" --json
  paseo daemon restart --host "$pilotAuthority" --timeout 30 --json
  ```

  不把目标写成无 --host 的默认命令。测试结束仅停止独立 daemon，确认直属 Runtime 子进程退出与锁释放，保留安全摘要。

- [ ] **3. 真实模型与桌面检查。** 两个临时项目可使用同一已授权仓库的不同本地 clone，显式登记为不同项目，不复制生产绑定、pending 或 grant。部署配置只使用已授权 CLI 引用；禁用 watcher、prepare 不写仓库外部。分别请求 A/B 追问并在各自 Ticket 目录写不同哨兵结果，核验对应前台回复与项目 workspace 下的 worker。

  关闭一个前台连接，另一项目仍能交互；reload 隔离插件后恢复旧对话。桌面“关窗口”在有授权的隔离会话中检查；不得为了演练强退用户正在使用的整个 Paseo 应用。keepRunningAfterQuit 的两种分支先用 v0.15.3 公开实现/fixture 验证，需要实际退出桌面才能确认的部分明确标为未实测，不改用户设置冒充验收。

- [ ] **4. 迁移前记录真实项目信息。** 核对实际 deployment.repository、仓库 root 和别名，不能因代码在本目录就认定受管项目是本目录。从原实例只读提取 masterId、conversation binding、旧 Paseo agentId/cwd/parent/workspace、Ticket 摘要、flow-web 端口和 watcher 开关，不输出凭据/完整工具配置。

  没有活跃用户外部写任务时再交接；存在时等待结束。登记稳定 id='legacy'、原 stateDir 和明确 root/aliases，并配置 legacyProjectId='legacy'。保留原模型/mode、Node/MCP 路径和 flow-web 端口；不要套用示例的模型权限。

- [ ] **5. 停旧宿主、备份、切 managed。** 精确 disable 现有 superagent 插件，等待原锁与所属进程退出，再复制完整 stateDir，保留权限。写入 managed local-config、managerDir 与单个 legacy 登记；启用插件，打开原 v1 对话触发恢复并检查 persistence 升为 v2。

  ```sh
  paseo plugin disable superagent --host 127.0.0.1:6767
  paseo plugin enable superagent --host 127.0.0.1:6767
  node bin/superagent-local.mjs --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check status
  ```

  两个命令之间必须完成锁释放、备份、配置切换，不能直接连续执行。核对身份/历史/flow-web 未变；在原前台完成一次只读任务验证结果回传。旧 v1 binding 不匹配时停下诊断，不新建对话遮盖迁移失败。

- [ ] **6. 实测回滚往返与恢复意图。** 先停止 managed 插件及其真实 child，确认所有权释放后恢复 embedded 配置，沿用同一 stateDir；验证 accepting、历史与旧绑定，再切回 managed。不得以旧备份覆盖迁移后的任务。验证 legacy 手动 stop 后打开旧对话不会自动 start，显式 start 才恢复；最终按用户日常使用保留可用状态。

- [ ] **7. 全量检查与交付记录。** 完成代码自审：顺序覆盖项目路径、persistence、进程竞态、管理意图、cleanup、构建边界。新增 fixture/测试/模块登记齐全，保留现有画布源码和锁文件的用户改动。

  ```sh
  pnpm check
  git diff --check
  ```

  验收记录写实际版本、测试数量、双项目 PID/身份摘要、相同 messageId 对账、精确进程退出、锁交接、内存/RSS 观察和局限。空闲 RSS 只作本次机器样本，不承诺固定每项目开销。说明日常项目绑定、CLI 停启、daemon 与桌面退出区别、无自动回收、needs_setup、旧会话与回滚路径。未实测的桌面分支或 Node/平台单独列出。

**完成标准：** 一个 provider 正确服务多个独立项目；现有实例原地迁入且可回滚，daemon 及项目停启有明确恢复意图，所有已确认缺陷闭环，未验证环境不包装成完成证据。

## 计划自查与执行交接

| 规格范围 | 对应任务 |
| --- | --- |
| 项目 root/alias、身份与新 workspace | 任务 1 |
| 单项目子进程、环境、父 IPC 断开与有界退出 | 任务 2 |
| 按需启动、手动停启、重启意图与总 cleanup 预算 | 任务 3 |
| 一个 provider、v2 persistence、v1 legacy、pending 隔离 | 任务 4 |
| 管理 CLI、同步插件、旧配置、二次编译和产物边界 | 任务 5 |
| 双项目真实任务、独立 daemon 重启、迁移/回滚/文档 | 任务 6 |

- 五项 Review Focus 均有具体用例，超时不作为所有权交接证据；不把打开多个窗口误记为创建多个 Runtime。
- 类型、消息与公共函数名称以共同接口为准；manager 的运行意图与项目业务状态严格分开。
- 示例没有要求新建 GitHub 资源、启用 watcher、修改桌面设置或发起审批；仅在隔离验收成功后才接管日常实例。
- 执行顺序为任务 1→6；保留当前仓库、分支和未提交改动，不因计划存在自动创建 worktree、commit、PR 或派发子代理。
- 六项交付已在原工作树完成，日常实例保持 managed；未推送，未启用外部 watcher，未更改桌面退出设置。原详细步骤用于设计追踪，最终证据与未实测项见验收记录。
