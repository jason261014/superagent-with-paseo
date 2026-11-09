# Paseo Plugin Host Implementation Plan

> **For agentic workers:** Implement this plan one task at a time, run each task's tests before moving to the next, and track progress with checkbox (`- [ ]`) syntax.

**Goal:** 由现有 Paseo Superagent 插件托管控制面，迁移当前已配置实例，使日常对话和任务执行不再需要 DSH 进程。

**Architecture:** 保留一个公共 Runtime，通过小型宿主接口组装运行环境和执行后端。DSH 入口负责 Cordis 注册，Paseo 插件加载独立 ESM 宿主产物；两者沿用相同的领域逻辑、SQLite 与私有 IPC。插件实例拥有控制面生命周期，聊天连接不拥有它。

**Tech Stack:** TypeScript、Node.js、SQLite (`node:sqlite`)、pnpm、tsdown、Vitest、Paseo plugin / client SDK。

**Spec:** [已确认设计](../specs/2026-11-08-paseo-plugin-host-design.md)。2026-11-08 已实施并完成当前实例迁移；勾选表示该步骤的交付与验收已完成，不表示逐字执行过下面每段示例或每次历史红灯命令。实际命令、结果、范围差异见 [验收记录](2026-11-08-paseo-plugin-host-validation.md)。

## Global Constraints

- 生产保持 **Paseo v0.15.2**；`@getpaseo/plugin@0.14.0`、`@getpaseo/client@0.8.0` 未升级。独立重启验证启动了本机应用当前自带的 v0.15.3 daemon，使用独立 home/端口，未重启生产 daemon。
- Node 要求沿用 `package.json` 的 `^22.19.0 || >=24.0.0`。Paseo Helper 已核查为 Node `24.20.0`；本机终端 Node 当前是 `/Users/anxiaojie/.nvm/versions/node/v24.13.0/bin/node`，实施时重新验证其可执行性。
- 继续使用当前仓库 `/Users/anxiaojie/src/superagent-with-paseo` 与分支 `codex/paseo-integration`，保留现有未提交改动；不新建项目、不推送、不自动创建 PR。
- 现有 `src/core` 业务状态机、Policy、Ticket、`ready` 完成语义、Outbox、消息幂等与角色授权继续沿用。
- 当前真实状态目录仍为 `/Users/anxiaojie/.dsh/state/sa-paseo-check`，不因换宿主改名或双写；锁在 SQLite 安全关闭后才释放。
- 一个插件实例、一个状态目录、一个 Runtime。继续保留 Local IPC 与 MCP 私有工具桥。
- contribution 同步返回 cleanup；正常 cleanup 以约 1 秒完成为目标，不能依赖 Paseo 在约 2 秒后仍不终止插件。
- 首版沿用当前 GitHub deployment/setup 检查，不启用 GitHub/飞书 watcher，不新增 DSH 面板的替代 UI。
- 不修改现有 provider/model 和权限模式，不修改已有 agent 的冻结配置；不使用 `superagent` 作为 orchestrator/worker 的模型 provider。
- 所有新 `src/*.ts` 和 `tests/*.spec.ts` 必须同步登记到 `docs/007-architecture.md` 对应表，否则 `tests/docs.spec.ts` 会失败。
- DSH 类型导入可以暂留；独立宿主产物的实际运行依赖必须不加载 `@deepseek-ai/*`。开发环境安装了旧依赖不构成通过依据。
- 每个任务跑对应的定向测试，最终跑一次 `pnpm check`；不在每次小修改后重复全套测试。

## Review Focus

1. cleanup 发生在动态 import、锁等待或 setup 尚未结束时：不允许停止后又启动一个 Runtime。归任务 4、5 的延迟启动测试。
2. 旧宿主仍持锁、同目录的第二个插件实例或异常退出后遗留锁：不得双写、强删活锁或重新接管旧异步写入。归任务 4 的双进程测试。
3. create/send 已到达 Paseo、宿主未保存确认就退出：恢复必须对账，不能把查不到当成可重发。归任务 4、6 的故障窗口测试。
4. 插件的 cwd、ESM 资源位置和 `process.execPath` 与 DSH 不同：提示词、skills、MCP 入口和 Node 启动路径都必须有效。归任务 3、5 的构建产物及新 worker 测试。
5. 多窗口或 provider 空闲回收、同一消息重试及旧消息重放：只能共享一个宿主，不能停全局任务、重复接收或串 Ticket。归任务 5、6 的连接与对话测试。

---

## 文件边界与接口

以下新增文件按职责拆分，不建立第二套编排框架。实际移动函数时保留原注释、签名和测试覆盖；兼容性的 re-export 只保留在 DSH 侧，独立宿主不能通过它反向导入 DSH。

| 文件 | 责任 |
| --- | --- |
| `src/hosts/dsh-config.ts` | 从 deployment 移出的 Schemastery `Config`、`DeploymentConfig`、`machineOf` |
| `src/deployment.ts` | 普通 Machine/Deployment 类型、账号 schema 和 setup 探测，不再有 DSH 值导入 |
| `src/executor/shared.ts` | 两种后端实际共享的任务目录、指令、消息和 prepare 辅助函数 |
| `src/infra/worker-command.ts` | 窄命令接口、环境过滤和 Node 执行实现 |
| `src/hosts/contracts.ts` | 宿主依赖与后端组装接口；只用类型导入引用 Runtime |
| `src/hosts/dsh.ts` | DSH 命令适配、原生后端组装、HTTP/模型/flush 接线及 Cordis 注册 |
| `src/paseo/backend.ts` | 从 Runtime 移出的现有 Paseo sessions/executor/bridge/reports 组装 |
| `src/app/runtime.ts` | 保留公共应用组装，改为普通类，实现共同启动和最终资源关闭 |
| `src/hosts/paseo.ts` | `createPaseoHost`、普通配置校验、后台启动、状态与停止预算；构建为 `lib/paseo-host.js` |
| `src/hosts/lifecycle.ts` | 宿主退出记录、停止预算和锁等待；不持有第二套 Ticket 状态 |
| `src/paseo-ui/host-control.ts` | 插件的外部/内嵌模式、动态加载、启动取消和状态；构建到 `paseo-plugin/server/` |
| `paseo-plugin/index.server.ts` | 同步注册原 provider，创建唯一 host control，返回异步 cleanup |

后续任务共同使用以下名称，实施时在所列文件中导出。`RunWorkerCommand` 返回 stdout，并以现有 `CliError` 或 AbortError 表达失败：

```ts
// src/infra/worker-command.ts
export interface WorkerCommand {
  argv: readonly string[]
  cwd: string
  signal: AbortSignal
  env?: Record<string, string>
}
export type RunWorkerCommand = (command: WorkerCommand) => Promise<string>
export function createNodeWorkerRunner(): RunWorkerCommand
export function workerEnvironment(
  ambient: NodeJS.ProcessEnv,
  explicit?: Record<string, string>,
): Record<string, string>
```

公共 Runtime 后端接口用现有类型约束，避免把整套 Context 仿造出来：

```ts
// src/hosts/contracts.ts；下列 import 全部是 type import。
import type { Runtime } from '../app/runtime.ts'
import type { SessionPort } from '../paseo/sessions.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { ResourceHost } from '../app/resources.ts'
import type { LinkHost } from '../app/links.ts'
import type { MainToolsHost } from '../app/tools/main.ts'
import type { ExecutorToolsHost } from '../app/tools/executor.ts'
import type { HttpHost } from '../app/http.ts'
import type { SettingsHost } from '../app/settings.ts'
import type { RunWorkerCommand } from '../infra/worker-command.ts'

export interface HostLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
export type ExecutorPort = Pick<DshExecutor,
  'prepare' | 'start' | 'stop' | 'deliver' | 'install' | 'resume' |
  'shutdown' | 'dispose' | 'activeCount'>
export interface BackendServices {
  runtime: Runtime
  links: LinkHost
  sourceLink: ResourceHost['sourceLink']
  tools(): MainToolsHost & ExecutorToolsHost
  closing(): boolean
  paused(): boolean
}
export interface RuntimeBackend {
  sessions: SessionPort
  executor: ExecutorPort
  transcript: ResourceHost['transcript']
  start(): Promise<void>
  stop(): Promise<void>
}
export type BackendFactory = (services: BackendServices) => RuntimeBackend
export interface RuntimeHost {
  logger: HostLogger
  runWorker: RunWorkerCommand
  backend: BackendFactory
  modelCatalog: ResourceHost['modelCatalog']
  validateModel: NonNullable<SettingsHost['validateModel']>
  mountHttp?: (host: HttpHost) => () => void
}
```

`BackendServices.runtime.engine`、`tools()` 在构造时尚未完整就绪。后端必须沿用现有 getter/回调方式延迟读取，不能在 factory 内提前解构 engine 或执行工具。`backend.start()` 负责桥等后端资源的启动，`backend.stop()` 负责其最终清理；公共 Runtime 仍拥有 Store 与目录锁。

独立宿主、插件 wrapper 和测试统一使用这个接口；这是新增边界，不改变现有 `Runtime.stop(): Promise<void>` 的“实际关闭已完成”含义：

```ts
// src/hosts/lifecycle.ts
export interface HostStatus {
  phase: 'starting' | 'needs_setup' | 'ready' | 'stopping' | 'stopped' | 'error'
  detail?: string
}
export type HostStop = { closed: true } | { closed: false; reason: 'deadline' }
export interface PaseoHost {
  ready: Promise<void>
  status(): HostStatus
  stop(budgetMs?: number): Promise<HostStop>
}

// src/hosts/paseo.ts
// HostConfig 用 zod 校验；limits 的默认值与 src/limits.ts / 当前 Config 一致。
export interface HostConfig {
  stateDir: string
  paseo: {
    url: string
    orchestrator: string
    worker: string
    orchestratorMode: string
    workerMode: string
    bridgeCommand: string
    bridgeNode: string
  }
  promptMaxChars?: number
  admissionContextMaxPages?: number
  admissionContextTimeoutMs?: number
}
export interface PaseoHostOptions {
  runWorker?: RunWorkerCommand
  createAdapter?: (options: PaseoAdapterOptions) => PaseoAdapter
  lockWaitMs?: number
}
export function createPaseoHost(config: HostConfig, options?: PaseoHostOptions): PaseoHost
```

`RunWorkerCommand`、`PaseoAdapterOptions` 和 `PaseoAdapter` 在 `src/hosts/paseo.ts` 从对应文件进行类型导入。`createPaseoHost()` 返回后后台初始化；`ready` 在 ready 或 needs_setup 时完成，在致命错误时拒绝，错误也写入 `status()`。停止预算耗尽只表示等待结束，不表示底层工作已经停止，不允许据此释放资源或启动继任实例。

## Task 1: 拆出配置和共享执行辅助函数

**Files:** 新增 `src/hosts/dsh-config.ts`、`src/executor/shared.ts`；修改 `src/deployment.ts`、`src/index.ts`、`src/executor/dsh.ts`、`src/paseo/sessions.ts`、`src/app/runtime.ts` 和引用迁出符号的测试；新增 `tests/host-boundaries.spec.ts`；更新架构表。

**Interfaces:** 消费原 `Config`、`Machine` 和执行辅助函数；产出可被普通 Node 加载的 deployment/shared 模块。Machine 的 volatile 字段收敛为结构类型 `{ get(): number }`，DSH 的现有 volatile 对象仍满足它。

- [x] **1. 保存工作树基线并记录相关检查。** 先读 `git diff`，确认保留上一轮 parent/workspace 修改。运行下列现有测试；失败时先区分原有问题，不覆盖用户改动。

  ```sh
  pnpm exec vitest run tests/deployment.spec.ts tests/environment.spec.ts tests/paseo-sessions.spec.ts
  ```

- [x] **2. 添加运行依赖边界测试。** 用 Vitest 的失败 mock 导入 deployment/shared，确认不求值 Schemastery；断言共享函数实际存在，防止只靠删掉导出通过测试。

  ```ts
  import { expect, it, vi } from 'vitest'
  vi.mock('@deepseek-ai/schemastery', () => {
    throw new Error('DSH schema loaded by a host-neutral module')
  })
  it('loads deployment and shared execution without DSH configuration', async () => {
    const deployment = await import('../src/deployment.ts')
    const shared = await import('../src/executor/shared.ts')
    expect(deployment.GithubAccountsSchema.parse({}).repository).toBe('')
    expect(shared.workerSessionId('ticket-a')).toBe('worker-ticket-a')
  })
  ```

  先运行 `pnpm exec vitest run tests/host-boundaries.spec.ts`，应因旧静态依赖或缺少 shared 模块失败。

- [x] **3. 移动 Config 和共享代码，修改 import。** 将 `Config`、`DeploymentConfig`、`machineOf` 移入 DSH 配置文件。将 `workerSessionId`、`ticketOfSession`、`sourceTrigger`、`ticketExecution`、`mandateInstructions`、`triggerMessage`、`batchOf`、`batchLine`、`inputResource`、`inputMessage` 和它们所需私有辅助函数移到 shared。`WorkerSlots` 与原生 background 处理留在 dsh executor。`prepareWorkerDirectory` 随任务 3 接入 RunWorkerCommand 后移出；本任务不伪造 subprocess。

  ```ts
  // src/index.ts
  import { Config, machineOf, type DeploymentConfig } from './hosts/dsh-config.ts'
  // src/paseo/sessions.ts
  import { mandateInstructions, workerSessionId } from '../executor/shared.ts'
  // src/deployment.ts
  export interface LiveNumber { get(): number }
  ```

  deployment 不能 re-export DSH Config，否则 ESM 会重新建立值依赖。原 executor 可为旧测试/调用方 re-export 共享函数，但新宿主只导入 shared。

- [x] **4. 验证配置与指令行为未改变。** 跑边界测试和步骤 1 的定向测试，再跑 `pnpm typecheck`。特别检查 `parent`、`paseo.parent-agent-id`、`DSH_SUPERAGENT_DIR` 和 `cd` 指令仍来自当前工作树。

**完成标准：** deployment/shared 可独立导入，现有 DSH Config 的字段、默认值和校验结果一致。

## Task 2: 保留公共 Runtime，用宿主接口替换 Context

**Files:** 新增 `src/hosts/contracts.ts`、`src/hosts/dsh.ts`、`src/paseo/backend.ts`；修改 `src/app/runtime.ts`、`src/app/setup.ts`、`src/app/settings.ts`、`src/index.ts`；更新 `tests/runtime.spec.ts`、`tests/runtime-concurrency.spec.ts`、`tests/index.spec.ts`、`tests/settings.spec.ts` 及相关 fixture；更新架构表。

**Interfaces:** 消费任务 1 的普通配置/辅助函数及本计划的 RuntimeHost/RuntimeBackend；产出普通类 `Runtime(host, machine, restart)` 和 `createDshRuntime(ctx, machine, restart): Runtime`。`createPaseoBackend(services, createAdapter?)` 返回 RuntimeBackend；可选工厂供后续隔离测试使用。

- [x] **1. 更新原 Runtime 测试的构造入口。** 将需要 DSH Context 的 `new Runtime(ctx, machine, restart)` 改为 `createDshRuntime(ctx, machine, restart)`，类型标注仍使用 Runtime。在 `tests/index.spec.ts` 原插件启动场景中补断言：`ctx.orchestrator` 能提供 SourceHost，卸载后服务被移除。

  ```ts
  // 放在已有 Runtime fixture 完成启动的测试中。
  expect(ctx.orchestrator.sources).toBe(runtime.sources)
  expect(runtime.configured()).toBe(true)
  expect(typeof runtime.context).toBe('function')
  ```

  先运行 `pnpm exec vitest run tests/index.spec.ts tests/runtime.spec.ts`，新入口未实现时应失败。

- [x] **2. 提取两个后端组装，消除公共 Runtime 的 DSH 值导入。** 将现有 Paseo 分支连同 journal、bridge、reports 和 transcript 接线移入 `src/paseo/backend.ts`，将原生 Sessions/DshExecutor、模型目录、原生取消/flush 接线移入 `src/hosts/dsh.ts`。保留其内部调用顺序和延迟读取 engine/tools 的方式。

  ```ts
  // 公共 Runtime 的构造接线；links/link 是原有 LinkHost 和 sourceLink 回调。
  this.backend = host.backend({
    runtime: this, links, sourceLink: link,
    tools: () => this.toolHost,
    closing: () => this.closing(), paused: () => this.paused(),
  })
  this.sessions = this.backend.sessions
  this.executor = this.backend.executor
  ```

  原 native factory 仍从它闭包中的真实 ctx 读取 Agent/Session；Paseo factory 不接收 Context。`Runtime.initialize()` 调用可选 mountHttp、公共 setup、后端 start、ensure 和原调度启动；删除 `instanceof PaseoSessions` 形式的宿主分支。

- [x] **3. 用 Cordis 原生 provide 接回旧入口。** 已核实 Cordis 的 `ctx.provide(name, value)` 返回 unregister disposer。公共 Runtime 不继承 Service；注册归 DSH 入口。注册/构造失败时必须取消注册并停止已构造 Runtime，不能留下锁。

  ```ts
  // createDshRuntime 的注册顺序。
  const unprovide = ctx.provide('orchestrator')
  try {
    const runtime = new Runtime(host, machine, restart)
    ctx.set('orchestrator', runtime)
    return runtime
  } catch (error) {
    unprovide()
    throw error
  }
  ```

  `host` 是同函数中构造的 RuntimeHost；ctx.set 之后新增失败点必须先调用 runtime.stop。module augmentation 移到 DSH 文件。保留 `src/index.ts` 已有 `ctx.effect` 清理与配置重启回调。

- [x] **4. 注入设置验证与日志。** `SettingsHost.validateModel` 变为必需字段，删除 settings 对 `resolveRoleModel` 的静态值导入及 ctx fallback；DSH factory 注入原函数，Paseo factory 保留“角色模型在 Paseo 配置中指定”的现有错误。Setup 使用 logger/runWorker/restart，不读取 Context。ResourceHost 的 DSH 类型引用不作为运行依赖加载。

- [x] **5. 跑跨后端回归。**

  ```sh
  pnpm exec vitest run tests/index.spec.ts tests/runtime.spec.ts tests/runtime-concurrency.spec.ts tests/settings.spec.ts tests/paseo-executor.spec.ts tests/paseo-sessions.spec.ts
  pnpm typecheck
  ```

**完成标准：** 原有 DSH 与 DSH 托管 Paseo 场景继续工作；公共 Runtime 的构造不需要 Context，没有复制第二套 Engine/Store 组装。

## Task 3: Node 命令执行与独立 ESM 宿主产物

**Files:** 新增 `src/infra/worker-command.ts`、`src/hosts/paseo.ts`、`tests/worker-command.spec.ts`、`tests/paseo-host.spec.ts`、`tests/fixtures/reject-dsh-loader.mjs`；修改 `src/infra/environment.ts`、`src/deployment.ts`、`src/executor/shared.ts`、`src/executor/dsh.ts`、`src/hosts/dsh.ts`、`src/paseo/sessions.ts`、`tsdown.config.ts`、`package.json`；更新对应测试及架构表。

**Interfaces:** 消费 RunWorkerCommand、RuntimeHost、createPaseoBackend；产出 `createNodeWorkerRunner()` 和 `createPaseoHost()`。PaseoConfig 增加可选 `bridgeNode`；独立 HostConfig 要求显式提供它，DSH 旧路径缺省仍用 process.execPath。

- [x] **1. 先锁定环境过滤与退出错误行为。** 已核查旧 DSH 过滤规则：ambient 中名称匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 或以 `DSH_` 开头的变量不继承，之后合并显式 env。沿用规则，不引入新的代理地址。

  ```ts
  import { expect, it } from 'vitest'
  import { workerEnvironment } from '../src/infra/worker-command.ts'
  it('filters ambient credentials but retains explicit task facts', () => {
    const env = workerEnvironment({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8',
      GH_TOKEN: 'ambient', DeepSeek_Api_Key: 'ambient', dsh_session: 'old',
    }, { DSH_SUPERAGENT_DIR: '/tmp/ticket-a' })
    expect(env).toEqual({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8', DSH_SUPERAGENT_DIR: '/tmp/ticket-a',
    })
  })
  ```

  另在同文件使用临时目录与 `process.execPath -e` 子进程验证：退出码 7 转换成 CliError.exitCode=7；取消正在等待的命令会等待该子进程实际退出；超过 stdout 1 MiB 或 stderr 64 KiB 上限会终止并失败。子进程测试清理在 finally 内完成，不使用全局进程名匹配。

- [x] **2. 实现 runner 并替换 workerProbe/prepare 依赖。** Node runner 使用 `spawn(argv[0], argv.slice(1), { shell: false, cwd, env, stdio })`。显式 env 在过滤后合并，stdin ignore，捕获输出有界；AbortSignal 在 spawn 前检查，之后取消只终止本 runner 创建的进程/进程组。完成以 close 事件为准，取消不以“信号已发出”冒充结束。

  ```ts
  export function workerEnvironment(ambient: NodeJS.ProcessEnv,
    explicit: Record<string, string> = {}): Record<string, string> {
    const safe = Object.fromEntries(Object.entries(ambient).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
        && !/KEY|PASSWORD|SECRET|TOKEN/i.test(entry[0])
        && !entry[0].toUpperCase().startsWith('DSH_'),
    ))
    return { ...safe, ...explicit }
  }
  ```

  DSH adapter 使用真实 `ctx.subprocess.spawn()` 实现同一接口，保留原过滤能力。迁移 `runAsWorker` 调用点、workerProbe、verifyEnvironment、verifyDirectory 与 prepareWorkerDirectory；调用者传入 runner，不能在公共模块构造假的 Context。

- [x] **3. 增加普通配置解析和宿主启动。** 用 zod strict schema 校验 HostConfig，复用 LIMITS。stateDir、bridgeCommand、bridgeNode 都要求绝对路径；bridge 文件存在，bridgeNode 可执行；Paseo URL 沿用现有 loopback 校验。orchestrator/worker 和 mode 均显式非空，并拒绝递归选择 superagent。解析失败在打开 Store 前结束。将数值限制包成 `{ get: () => value }`，强制 localRequests=true，随后使用公共 Runtime。

  空临时状态应进入 needs_setup，而非隐式创建仓库或请求外部授权。沿用 SQLite 现存 source 配置，新的宿主配置不覆盖业务设置。

- [x] **4. 固定 MCP 解释器。**

  ```ts
  // PaseoSessions.options() 中创建新 agent 的 MCP 配置。
  command: config.bridgeNode ?? process.execPath,
  args: [config.bridgeCommand],
  ```

  保留现有 socket/token env 与 alwaysLoad。对测试显式传入不同于 process.execPath 的 bridgeNode，断言新配置使用它；已有 `paseo-session-config:` 和绑定不能被重写。宿主真实启动前执行所配置 Node 的 `--version` 和最小 MCP import 检查，不用 Electron Helper 是否碰巧继承某个环境变量作为保证。

- [x] **5. 生成独立产物，验证完整 import 图。** 在 tsdown 的 lib ESM entries 增加 `paseo-host: src/hosts/paseo.ts`，package exports 增加 `./paseo-host`。保留 prompts/skills 和原 MCP 文件位置。新增 loader 拒绝任何真实 DSH 解析：

  ```js
  // tests/fixtures/reject-dsh-loader.mjs
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      throw new Error('Unexpected DSH runtime import: ' + specifier)
    }
    return nextResolve(specifier, context)
  }
  ```

  ```sh
  pnpm build
  node --loader ./tests/fixtures/reject-dsh-loader.mjs --input-type=module -e 'const host = await import("./lib/paseo-host.js"); if (typeof host.createPaseoHost !== "function") throw new Error("Missing host export")'
  pnpm exec vitest run tests/worker-command.spec.ts tests/paseo-host.spec.ts tests/environment.spec.ts tests/deployment.spec.ts tests/paseo-sessions.spec.ts
  ```

  还要在测试中用改变 cwd 的子进程导入产物、打开空临时状态、观察 needs_setup 后 stop，并确认相同目录可以再次取得锁。产物扫描同时检查未内联带入 DSH 值代码；loader 只负责发现外部解析，不能独自证明未被 bundle 内联。

**完成标准：** 新宿主不加载 DSH 即可得到可诊断的启动/未配置结果；Node runner 取消与环境语义正确，资源和 MCP 路径不依赖启动 cwd。

## Task 4: 有预算的停机、锁交接和故障恢复

**Files:** 新增 `src/hosts/lifecycle.ts`、`tests/host-lifecycle.spec.ts`、`tests/fixtures/host-lifecycle-child.ts`；修改 `src/app/runtime.ts`、`src/hosts/paseo.ts`、`src/paseo/backend.ts`、`src/paseo/client.ts`、`src/paseo/sessions.ts`、`src/executor/paseo.ts`、`src/kv.ts`、`src/local/transport.ts`；必要时调整现有 effects/bridge 的停止调用顺序；更新架构表。

**Interfaces:** 消费 PaseoHost/HostStatus/HostStop；保持 `Runtime.stop(): Promise<void>` 为幂等的最终清理 Promise。新增 `waitForHostStop(stopped: Promise<void>, budgetMs: number): Promise<HostStop>` 只负责等待预算，不关闭资源。PaseoAdapterOptions 可增加 lifetime AbortSignal，使连接和 CLI 调用可取消；SDK 不支持取消的调用仍必须计入未退出工作。

- [x] **1. 锁定“等待超时不等于资源已释放”。**

  ```ts
  import { expect, it, vi } from 'vitest'
  import { waitForHostStop } from '../src/hosts/lifecycle.ts'
  it('reports a deadline while leaving final cleanup pending', async () => {
    vi.useFakeTimers()
    try {
      let finish!: () => void
      const finalStop = new Promise<void>(resolve => { finish = resolve })
      const closed = vi.fn()
      void finalStop.then(closed)
      const bounded = waitForHostStop(finalStop, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await bounded).toEqual({ closed: false, reason: 'deadline' })
      expect(closed).not.toHaveBeenCalled()
      finish()
      await finalStop
      expect(closed).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  ```

  集成测试必须另验证实际 Store/锁，不用此单测替代：启动持锁子进程，在某个 effect 写后续记录前阻塞，调用 stop 预算超时，第二实例仍不能打开同目录；允许 effect 结束后才可交接。用子进程是为避免测试把遗留 async 回调留在 Vitest 主进程。

- [x] **2. 先冻结调度，再发取消，再等待最终清理。** 改造前 stop 在关闭 bridge 前尚未 drain effects；提前调用 effects.drain 以同步禁止新 dispatch，保留其 Promise 到后面等待。同时停止 passes/assessor，设置 closing、abort 应用命令，关闭两个入口的监听。对已证实属于本实例的活跃 agent 发出限时 interrupt；不能使用 engine 的用户 stop 命令改变 Ticket。

  ```ts
  // Runtime.shutdown() 的开始部分；后续仍等待这些 Promise 才关 Store。
  this.closingFlag = true
  const passStop = this.passes.stop()
  const effectStop = this.effects.drain()
  this.assessor.stop()
  this.stopped.abort()
  ```

  本地 HTTP listener 关闭后仍可能有解析请求的回调；写库前重查 closing/AbortSignal。桥必须等待已进入的 tool call，effect finalizer、executor 的 in-flight 任务、setup 初始化及后端 start 都要计入最终清理。任何一个未退出时，不能 close Store 或 releaseLock。不要用 Promise.race 的胜出结果触发这些动作。

- [x] **3. 加宿主级退出记录，不改 Ticket schema。** 在 KV 新增 `paseo-host-lifecycle`，值包含 version=1、启动 runId、phase=`running|stopping|stopped`、at、shutdownReason。start 得锁后读取旧值，再写本次 running；stop 先写 stopping，最终静默时写 stopped 后关库。该记录仅提示恢复/诊断，未决 create/send 仍以已有 journal 和回执为准。

  ```ts
  // src/kv.ts 中的独立元数据，不写 Ticket 结束字段。
  host: { lifecycle: record<{
    version: 1; runId: string; phase: 'running' | 'stopping' | 'stopped'
    at: string; shutdownReason?: string
  }>('paseo-host-lifecycle') },
  ```

- [x] **4. 实现可取消的锁等待与启动/停止互斥。** 默认最多等待 35 秒，沿用 proper-lockfile 的 stale=30 秒规则；每次只尝试正常取得锁，不删除锁目录。停止发生在等待中应取消后续尝试；即使迟到取得锁，也必须释放未使用的锁且不打开应用。活跃 DSH 持锁超时报告具体错误，不切 external、不另选目录。

  `ready` 仍未结束时调用 stop，先阻止所有后续启动步骤，待已经启动的资源收敛后清理。需要进程内重启时，只有最终 stop 完成才允许重建；预算耗尽则要求插件重载，不能同时运行第二代实例。

- [x] **5. 覆盖 create/send/report 故障窗口。** 扩展现有 `tests/paseo-executor.spec.ts` 和 `tests/paseo-control-journal.spec.ts`，使用同一真实临时 SQLite 在两次宿主实例间恢复：create 远端成功但确认未写、send 成功但回执未写、report 先到而 assignment 未标 started、旧 assignment 迟到报告。核对 adapter 的 create/send 调用次数及 Ticket/报告变化。

  对查找结果 unknown 或无完整证据的 absent，继续进入原有不明结果处理，保持业务阻塞；不得清 journal 或新建 assignment 来“恢复”。先恢复 bridge/绑定/回执，再执行 executor.resume 和调度。

- [x] **6. 执行生命周期与恢复测试。**

  ```sh
  pnpm exec vitest run tests/host-lifecycle.spec.ts tests/paseo-host.spec.ts tests/paseo-client.spec.ts tests/paseo-executor.spec.ts tests/paseo-control-journal.spec.ts tests/runtime-concurrency.spec.ts tests/effects.spec.ts tests/paseo-local-source.spec.ts
  ```

**完成标准：** 清理在正常条件下及时完成；无响应时返回 deadline，但不提前释放写入所有权。意外退出后能够等待锁过期并对账恢复，原 DSH 最终清理仍有效。

## Task 5: 将已有 Paseo 插件接到内嵌宿主

**Files:** 新增 `src/paseo-ui/host-control.ts`、`tests/paseo-plugin-host.spec.ts`；修改 `paseo-plugin/index.server.ts`、`paseo-plugin/shared/local-config.ts`、`paseo-plugin/shared/local-config.example.ts`、`src/paseo-ui/provider.ts`、`src/paseo-ui/connection.ts`、`tsdown.config.ts`、`tsconfig.json`；更新 `tests/paseo-ui.spec.ts` 及架构表。

**Interfaces:** 消费 createPaseoHost/PaseoHost。新增 `createPluginHostControl(options)` 返回 `status(): HostStatus` 和 `stop(budgetMs?: number): Promise<HostStop>`；options 是 external/embedded 判别联合，embedded 包含 runtimeEntry 与 HostConfig，以及测试可注入的 `loadRuntime`。

```ts
// src/paseo-ui/host-control.ts
export interface HostModule {
  createPaseoHost(config: HostConfig): PaseoHost
}
export type PluginHostOptions =
  | { mode: 'external' }
  | { mode: 'embedded'; runtimeEntry: string; config: HostConfig;
      loadRuntime?: (entry: string) => Promise<HostModule> }
export interface PluginHostControl {
  status(): HostStatus
  stop(budgetMs?: number): Promise<HostStop>
}
export function createPluginHostControl(options: PluginHostOptions): PluginHostControl
```

HostConfig 和生命周期类型只做 type import，不能静态加载宿主模块。external 模式不使用控制器状态宣称后台 ready：provider 继续按原 IPC 判断；host control 在 external 下只是 no-op cleanup。

- [x] **1. 添加停止早于 import 完成的回归测试。**

  ```ts
  import { expect, it, vi } from 'vitest'
  import { createPluginHostControl, type HostModule } from '../src/paseo-ui/host-control.ts'
  it('does not start a host after cleanup has already completed', async () => {
    let loaded!: (module: HostModule) => void
    const pending = new Promise<HostModule>(resolve => { loaded = resolve })
    const createPaseoHost = vi.fn()
    const control = createPluginHostControl({
      mode: 'embedded', runtimeEntry: '/tmp/superagent-host.js',
      config: {
        stateDir: '/tmp/superagent-host-test',
        paseo: { url: 'ws://127.0.0.1:6767/ws', orchestrator: 'codex', worker: 'codex',
          orchestratorMode: 'read-only', workerMode: 'read-only',
          bridgeNode: process.execPath, bridgeCommand: '/tmp/superagent-mcp.js' },
      },
      loadRuntime: () => pending,
    })
    expect(await control.stop(1000)).toEqual({ closed: true })
    loaded({ createPaseoHost })
    await Promise.resolve()
    await Promise.resolve()
    expect(createPaseoHost).not.toHaveBeenCalled()
  })
  ```

  再覆盖 import 抛错、ready 拒绝、needs_setup、重复 stop、两个 provider connect 后关闭一个连接。后者不能调用 host.stop。

- [x] **2. 实现同步 wrapper 和绝对 ESM 加载。** 用 `pathToFileURL(runtimeEntry).href` 进行变量动态 import，校验模块导出的 createPaseoHost。加载/ready 的拒绝都捕获到 HostStatus.error 和日志；cleanup 标志在每个 await 后检查，避免迟到启动。

  ```ts
  const loadRuntime = async (entry: string): Promise<HostModule> => {
    const module = await import(pathToFileURL(entry).href)
    if (typeof module.createPaseoHost !== 'function') {
      throw new Error('Superagent runtime module has no createPaseoHost export')
    }
    return module
  }
  ```

  `index.server.ts` 保持普通函数：创建 control、同步 registerProvider、返回 async cleanup。不能 await host.ready 后才注册 provider，也不能在 `connect()` 中创建 Runtime。

- [x] **3. 添加配置但保持现有实例在 external。** 保留原 stateDir override，增加 `hostMode`、`runtimeEntry` 和 `hostConfig`。`shared/local-config.ts` 保持纯数据，类型放在独立声明文件，路径处理仍在 server；环境变量 SUPERAGENT_STATE_DIR 必须同时作用于 provider 和宿主。embedded 模式下缺字段、路径冲突或不同 stateDir 立即报错，不能静默使用另一个目录。

  示例文件明确写两种模式；宿主参数从原 profile 逐项复制到私有本地配置，不能导入/求值整个 Cordis patch。交接前保持 external，已在任务 6 实际交接时切换为 embedded。

- [x] **4. 提供清楚的可用状态而不改接收语义。** 给 provider 增加可选 `hostStatus: () => HostStatus`，透传到 connection。embedded 的 starting/needs_setup/error 通过现有 `session.notice` 展示；没有 durable receipt 时不得显示任务已接单。保留现有 pending 文件和 receipt reconciliation，宿主停止不把不明输入丢掉。GET `/status` 可增加可选 host 字段，原 configured/paused/accepting/actor 字段不变。

  provider session 的关闭只释放 polling/订阅。注册函数返回的插件 cleanup 才调用 control.stop。deadline 时记录警告并交回 Paseo 的外层进程终止机制，不解锁、不自行启动替代进程。

- [x] **5. 验证两次构建与类型边界。** 将 host-control 构建到 `paseo-plugin/server/host-control.mjs`；宿主 runtimeEntry 保持独立 ESM。把插件入口纳入 typecheck 或为它设置独立 tsconfig，修正当前隐式 server 参数类型；generated mjs 的声明/类型导入与源码类型保持一致。

  ```sh
  pnpm exec vitest run tests/paseo-plugin-host.spec.ts tests/paseo-ui.spec.ts tests/local-conversation.spec.ts tests/local-transport.spec.ts
  pnpm build
  pnpm typecheck
  ```

  在隔离的插件实例中检查 Paseo 二次编译后的动态 import、资源位置和日志。不能只测试 tsdown 产物就声称插件环境可用。

**完成标准：** provider 注册立即完成；宿主后台启动、状态明确、停机有界；窗口/连接与全局控制面生命周期分离，external 模式仍可回滚。

## Task 6: 完整验证、当前实例迁移与文档

**Files:** 新增 `docs/superpowers/plans/2026-11-08-paseo-plugin-host-validation.md`；更新 `docs/local-usage.md`、`PASEO.md`、`docs/007-architecture.md`、`docs/project-overview.zh.md` 和本计划进度；必要的完整对话回归放在 `tests/paseo-host.spec.ts` / `tests/paseo-plugin-host.spec.ts`。

**Interfaces:** 消费已通过前五项验证的 lib/paseo-host.js、external/embedded 配置和既有本地 CLI；交付可回滚的当前实例迁移、实测记录及简明使用说明。

- [x] **1. 运行自动化验收。**

  ```sh
  pnpm check
  git diff --check
  ```

  记录实际测试数量/版本，不沿用上一轮的 1268 数字。失败要定位与修复，不通过删测试、调大时间预算或换新空目录掩盖恢复失败。

- [x] **2. 用隔离状态做真实闭环。** 为验证实例生成单独的配置和 plugin id，复制所需部署配置与 Policy，但不复制真实实例的 agent 绑定、运行 Ticket、对话身份或 tool grant。profile 中模型配置保持原 provider/model/mode；单独初始化只允许当前本地入口，不启动 source watcher。

  在 Paseo 的该验证实例对话中发送“先问我 A/B，收到回复后在任务目录写 result.txt”，回复 A。核验接单、问题、结果都回同一窗口，文件内容正确，worker 的 parent/workspace 匹配验证实例的 orchestrator。再打开第二窗口、关闭第一窗口，确认没有新建第二个 Runtime。

  在等待用户回复时重载验证插件、恢复后继续回答；在进行文件只读任务时终止验证插件子进程，验证 stale lock 等待与对账。对 create/send 确认丢失使用任务 4 的可控故障测试，不能靠随机杀真实用户任务来验证。完成后只清理自己建立的验证实例与测试 agent，不改变真实 workspace。

  实测范围：任务提交、续问和双连接使用真实 daemon 的 CLI/SDK provider 协议；桌面另核对原对话最终回复和 subagent 分组，不声称手工操作了完整双窗口流程。额外使用独立 home/端口的 v0.15.3 daemon 验证空配置实例重启、身份保留和停机释放锁。

- [x] **3. 记录真实实例迁移前身份。** 只读记录：conversation binding、masterId、Paseo orchestrator ID、workspaceId、现有 worker 绑定、Ticket 数量/状态、两个 source watcher 开关。记录摘要，桥接 token、账户凭据和原文不写入文档。重新读取当前 profile 的模型/mode/bridge 路径，不按历史摘要猜测。

  ```sh
  paseo daemon status --json
  paseo plugin ls --json
  node bin/superagent-local.mjs --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check status
  ps -axo pid=,command=
  ```

  确认迁移窗口没有正在执行外部写操作的用户任务；若有则先等其结束，不将切换宿主当作取消授权。根据完整 argv 唯一定位 `superagent-local-check` 的 DSH 进程，不使用 `pkill dsh` 或猜测旧 PID。

- [x] **4. 停旧宿主并取得一致备份。** 对已确认 PID 发 SIGINT，等待其退出与锁释放；未释放就不启动 embedded。随后复制整个私有状态目录，保留权限，以便包含 SQLite、WAL、journals、pending 输入和工具桥状态。

  ```sh
  umask 077
  superagent_state=/Users/anxiaojie/.dsh/state/sa-paseo-check
  superagent_backup="${superagent_state}.before-paseo-host.$(date +%Y%m%d%H%M%S)"
  cp -a "$superagent_state" "$superagent_backup"
  ```

  PID 的信号发送在人工/代理核对 argv 后执行，不能把此备份命令放到 DSH 仍写入数据库的阶段。原目录继续使用，备份不作为第二个运行实例。

- [x] **5. 切换当前同一插件并验收。** 将当前私有配置改为 embedded，runtimeEntry 指向本仓库 `lib/paseo-host.js`；stateDir 不变，使用验证过的 bridgeNode 和原角色配置，然后：

  ```sh
  paseo plugin reload superagent --host 127.0.0.1:6767
  paseo plugin ls --host 127.0.0.1:6767
  paseo plugin logs superagent --host 127.0.0.1:6767
  node bin/superagent-local.mjs --state-dir /Users/anxiaojie/.dsh/state/sa-paseo-check status
  ```

  确认 plugin running 且应用 ready，旧 conversation/master/agent/workspace ID 和 Ticket 均保持。再在原对话做一次本地只读任务，核验新 worker 绑定与结果回传。确认只停掉本 Superagent 所属的 DSH 进程；机器上的其他 DSH 实例不属于本次范围。

- [x] **6. 验证回滚顺序并更新使用说明。** 回滚先停止 embedded 插件宿主并等待锁释放，再改 external、重载 provider、恢复原 DSH profile。只有确认本次 schema 没有不兼容变更才使用同一数据库回滚；不覆盖切换后产生的新数据。

  ```sh
  dsh --profile superagent-local-check \
    --patch /Users/anxiaojie/.dsh/profiles/superagent-local-check/paseo.patch.yml \
    --no-open
  ```

  文档写清默认日常路径：Paseo daemon 运行 → 进入原 Superagent 对话 → 直接发消息；故障检查使用 plugin logs 与 local status。解释关闭窗口不会停全局任务，disable/reload 会影响控制面，以及不明停止状态的实际限制。

**完成标准：** 当前实例在没有对应 DSH 进程的条件下完成真实闭环，身份/绑定连续，恢复演练通过，并有带实际结果的验证记录。任何未实测项明确列为未验证，不能把自动化测试等同于用户窗口验证。

## 计划自查结果

- 规格覆盖：公共宿主边界（任务 1–3）、资源定位/MCP（任务 3、5）、生命周期与恢复（任务 4）、现有入口接管（任务 5）、迁移/回滚/使用说明（任务 6）都有对应步骤。
- 五项 Review Focus 均归属具体测试；涉及真实远端副作用的 create/send 故障使用可控 adapter，真实场景只做授权的本地验证。
- 不引入新的 Ticket 状态机、第二套数据库、默认监听、第三个常驻 host 进程或 SDK 升级。
- 阶段验收依赖实际最终关闭；HostStop.closed=false 不被用作资源释放或任务完成的证据。
- 当前真实实例已完成 DSH → embedded → external 回滚验证 → embedded 的交接，最后保持 embedded；没有推送、没有启用外部 watcher，也没有重启生产 daemon。
- 实现对接口示例做了小幅补充：后端增加 `quiesce()`，以便先取消/收敛再最终清理；宿主接口传递 `runId`、health 和命令 runner。公共 Runtime、Engine 和 Store 仍各只有一套。
- Paseo 二次编译不接受 shared 配置中跨到 server 的类型查询，因此 shared 文件保持纯数据，类型通过 `paseo-plugin/generated.d.ts` 与入口 typecheck 约束；已在真实插件验证。
- 当前未发现需要阻塞本轮交付的未闭环问题；剩余能力边界与未实测环境在验收记录中明确列出，不将其描述为已获得的保证。
