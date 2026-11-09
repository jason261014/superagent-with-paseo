# Superagent 流转画布 Implementation Plan

> **For agentic workers:** Implement this plan one task at a time, run each task's tests before moving to the next, and track progress with checkbox (`- [ ]`) syntax.

**Goal:** 在现有 Paseo 插件托管的 Superagent 宿主内提供只读本地 Web 页面，用 `@xyflow/react` 固定三列角色泳道画布与独立时间线可视化 `Superagent → Orchestrator → Worker` 的流转记录、当前状态与证据。

**Architecture:** 复用 `Runtime` 已持有的唯一 `Store` 实例做纯只读投影，不新增业务表、不打开第二个写库连接、不发起 LLM 调用。后端在 `createPaseoHost` 中按可选 `flowWeb` 配置挂载 `127.0.0.1` 只读 HTTP 服务（带本机 Bearer token 与严格字段白名单脱敏），前端用 React 18 + `@xyflow/react` 构建独立静态单页应用（输出到 `lib/flow-web/`，与旧 DSH `lib/client.js` 隔离）。

**Tech Stack:** TypeScript 6、Node `node:http` / `node:sqlite`、Zod 4、React 18.3、`@xyflow/react` 12.12.1、tsdown、Vitest 4 + jsdom。

**Spec:** `/Users/anxiaojie/src/superagent-with-paseo/docs/superpowers/specs/2026-11-08-superagent-flow-canvas-design.md`

## Global Constraints

- 只读可视化：不支持增删节点、连线、重试、取消、派工、发消息或修改 Policy，不发起任何 LLM 调用。
- 主图展示结构关系（固定三列泳道：`x = 80` Superagent 入口/控制面、`x = 460` Orchestrator、`x = 860` Ticket/Assignment/Worker），时间线展示先后顺序；多次汇报或追加输入聚合在稳定节点/边上，不复制 Worker 节点。
- 证据真实性：完整扇出合并 `TriggerDisposition.fanout`、`Decision.ticketId`、`ticket.origin` 与 `OutboundMessage.ticketId`；历史 Assignment 的 Worker `agentId` 优先取 `paseo_operation_intent(kind='create').result_id`；无时间戳的 `paseo_report_receipt` 与 `paseo_operation_intent` 不伪造时间戳；未确认意图显式标为 `unconfirmed`；严格区分 Worker `ready`、Ticket `completed` 与 Outbox `sent`，绝不显示“用户已读”。
- 安全与脱敏：仅监听 `127.0.0.1`；`/api/flow/*` 仅允许 `GET`/`HEAD` 且校验 `<stateDir>/flow-web/access.json`（`0600`）中的 Bearer token；严禁返回 `SUPERAGENT_BRIDGE_TOKEN`、环境变量、完整 `systemPrompt`、技能全文、GitHub/飞书凭证或私有 socket 路径。
- 构建与宿主边界：独立前端产物输出到 `lib/flow-web/`，不依赖 `@deepseek-ai/*` 或 `window.__ModuleLoader__`；`paseo-plugin/shared/local-config.ts` 保持纯数据导出；`host.stop()` 时先关闭 Web 服务与在途请求，再关闭 SQLite 和释放目录锁。

## Review Focus

1. 一条请求扇出到多个 Ticket，或一个 Ticket 经历多次 Assignment 时，画布不得只显示 `receipt.ticketId` 或被最新 `paseo-session:worker-<ticketId>` 覆盖历史 Worker `agentId`。归 Task 1 测试。
2. `paseo_report_receipt` 与 `paseo_operation_intent` 没有时间戳列，且 journal 可能处于 `result_id = null`；投影不得伪造 ISO 时间或将未确认操作渲染成已送达。归 Task 1 测试。
3. Session 配置和 `KV` 中含有 `SUPERAGENT_BRIDGE_TOKEN`、环境变量与完整 prompt；任何 `/api/flow/*` 响应都必须彻底剔除这些敏感字段。归 Task 1、Task 2 测试。
4. 宿主处于 `starting` / `needs_setup` / `stopping` 或正在 `stop()` 时访问 `/api/flow/*`，不得触发 `new Store()` 写迁移、不得读已关闭的 SQLite，且未授权请求必须 `401`。归 Task 2 测试。
5. 轮询刷新、展开历史 Assignment、点击底部时间线高亮节点/边时，前端不得丢失当前选中项或重置视口，且构建产物不得混入 `@deepseek-ai/*`。归 Task 3、Task 4 测试。

---

## 文件边界与接口

| 文件 | 责任 |
| --- | --- |
| `src/flow-web/model.ts` | 前后端共享的画布 DTO、泳道坐标常量、节点/边/时间线/未知项类型与脱敏辅助类型 |
| `src/flow-web/project.ts` | 从 `Store` 只读记录计算 `watermark`、`overview`、`ticket`/`request` 画布投影与按需 transcript 摘要 |
| `src/flow-web/server.ts` | `127.0.0.1` 只读 HTTP 服务、`access.json` 令牌生成与校验、静态资源与 4 个只读路由、优雅关闭 |
| `src/flow-web/ui/App.tsx` | 四区域单页界面（左侧列表、中央 React Flow 泳道画布、右侧证据抽屉、底部事件时间线） |
| `src/flow-web/ui/index.tsx` | 浏览器挂载入口与 URL hash token 读取 |
| `src/flow-web/ui/styles.css` | 画布、泳道、节点卡片、时间线与抽屉样式 |
| `src/hosts/paseo.ts` | `HostConfigSchema` 新增可选 `flowWeb`，挂载与停止 `FlowWebServer`，暴露 `flowWebUrl` 状态诊断 |
| `tsdown.config.ts` | 新增 `flow-web` 浏览器打包配置，输出 `lib/flow-web/app.js` |
| `tests/flow-web-project.spec.ts` | 只读投影、扇出、多 Assignment 历史 Worker、无时间戳证据与脱敏单元测试 |
| `tests/flow-web-server.spec.ts` | `127.0.0.1` 鉴权、只读方法限制、宿主生命周期与关闭顺序测试 |
| `tests/flow-web-ui.spec.ts` | React Flow 节点/边渲染、时间线联动高亮、Assignment 折叠展开与刷新保持状态测试 |

---

## Task 1: 只读画布数据模型与 Store 投影（`src/flow-web/model.ts`、`src/flow-web/project.ts`）

**Files:**
- Create: `src/flow-web/model.ts`
- Create: `src/flow-web/project.ts`
- Test: `tests/flow-web-project.spec.ts`

- [x] **Step 1: 编写投影单元测试 `tests/flow-web-project.spec.ts`**
  覆盖：
  - 请求 → Eval/Decision → Ticket → 多 Assignment（折叠与展开）→ 多次 `paseo_report_receipt` → Outbox 回复的固定泳道节点、聚合边与时间线；
  - 单条 Trigger 扇出到多个 Ticket 时完整返回全部关联 Ticket；
  - 历史 Assignment 从 `paseo_operation_intent(kind='create').result_id` 还原各自 Worker `agentId`，不被最新 `paseo-session:worker-<ticketId>` 覆盖；
  - `paseo_report_receipt` 与 `paseo_operation_intent` 无时间戳时不伪造时间，`result_id === null` 标为 `unconfirmed`；
  - `SUPERAGENT_BRIDGE_TOKEN`、环境变量与完整 `systemPrompt` 被彻底剔除。

- [x] **Step 2: 运行测试确认失败**
  Run: `pnpm exec vitest run tests/flow-web-project.spec.ts`

- [x] **Step 3: 实现 `src/flow-web/model.ts` 与 `src/flow-web/project.ts`**
  实现确定性三列泳道坐标（`x = 80 / 460 / 860`）、水位计算、左侧列表分页过滤、单请求/单 Ticket 图投影、主会话精确证据关联与白名单脱敏。

- [x] **Step 4: 运行测试确认通过**
  Run: `pnpm exec vitest run tests/flow-web-project.spec.ts`

---

## Task 2: 本地只读 HTTP 服务与 Paseo 宿主集成（`src/flow-web/server.ts`、`src/hosts/paseo.ts`）

**Files:**
- Create: `src/flow-web/server.ts`
- Modify: `src/hosts/paseo.ts`
- Modify: `src/hosts/lifecycle.ts`
- Modify: `src/local/transport.ts`
- Test: `tests/flow-web-server.spec.ts`

- [x] **Step 1: 编写服务与宿主生命周期测试 `tests/flow-web-server.spec.ts`**
  覆盖：
  - `127.0.0.1` 绑定、`<stateDir>/flow-web/access.json`（`0600`）令牌生成、无 token / 错 token 返回 `401`、`POST` 返回 `405`；
  - `/api/flow/overview`、`/api/flow/items/ticket/:id`、`/api/flow/items/request/:id`、`/api/flow/transcript/:sessionKey` 返回只读 JSON；
  - `createPaseoHost` 配置 `flowWeb: { enabled: true, port: 0 }` 时正常暴露访问 URL，并在 `host.stop()` 时先关闭 HTTP 服务再关闭 SQLite。

- [x] **Step 2: 运行测试确认失败**
  Run: `pnpm exec vitest run tests/flow-web-server.spec.ts`

- [x] **Step 3: 实现 `src/flow-web/server.ts` 并接入 `src/hosts/paseo.ts`**
  支持静态壳与 `/assets/*`、4 个只读 API、CSP/no-store 响应头、宿主阶段感知（`starting` / `needs_setup` / `ready` / `stopping` / `error`）以及有序停机。

- [x] **Step 4: 运行测试确认通过**
  Run: `pnpm exec vitest run tests/flow-web-server.spec.ts tests/paseo-host.spec.ts`

---

## Task 3: React Flow 画布前端与交互测试（`src/flow-web/ui/*`）

**Files:**
- Modify: `package.json`（添加 `@xyflow/react`）
- Create: `src/flow-web/ui/App.tsx`
- Create: `src/flow-web/ui/index.tsx`
- Create: `src/flow-web/ui/styles.css`
- Test: `tests/flow-web-ui.spec.ts`

- [x] **Step 1: 安装 `@xyflow/react` 并编写前端交互测试 `tests/flow-web-ui.spec.ts`**
  覆盖：
  - 左侧列表切换请求 / Ticket；
  - 中央画布渲染三列泳道节点与聚合边徽标；
  - 点击历史 Assignment 折叠节点可展开旧 Assignment；
  - 点击底部时间线事件高亮对应节点与边，并在右侧抽屉展示证据、未知项与按需 Transcript 按钮；
  - 轮询水位不变或更新时保留当前选中项与展开状态。

- [x] **Step 2: 运行测试确认失败**
  Run: `pnpm exec vitest run tests/flow-web-ui.spec.ts`

- [x] **Step 3: 实现 `src/flow-web/ui/App.tsx`、`src/flow-web/ui/index.tsx`、`src/flow-web/ui/styles.css`**
  使用 `@xyflow/react` 自定义只读节点卡片与边标签，固定禁用拖拽/连线/删除操作，支持 URL `#token=...` 自动鉴权与 `sessionStorage` 持久化。

- [x] **Step 4: 运行测试确认通过**
  Run: `pnpm exec vitest run tests/flow-web-ui.spec.ts`

---

## Task 4: 独立浏览器构建产物与边界验证（`tsdown.config.ts`、`tests/host-build.spec.ts`）

**Files:**
- Modify: `tsdown.config.ts`
- Modify: `tests/host-build.spec.ts`

- [x] **Step 1: 在 `tests/host-build.spec.ts` 增加 `flow-web` 构建产物断言**
  断言 `flow-web/app.js` 与 `flow-web/app.css` 生成成功、无 `@deepseek-ai/*` 依赖、无 `window.__ModuleLoader__` 包装，且 `paseo-host.js` 仍保持无 DSH 运行时依赖。

- [x] **Step 2: 更新 `tsdown.config.ts` 增加 `src/flow-web/ui/index.tsx` 浏览器打包项**
  将 React、`react-dom/client` 与 `@xyflow/react` 打包为本机自包含浏览器脚本与样式，不依赖外部 CDN。

- [x] **Step 3: 运行构建与边界测试**
  Run: `pnpm exec vitest run tests/host-build.spec.ts tests/host-boundaries.spec.ts`

---

## Task 5: 全量验证、本机真实数据只读冒烟与使用文档更新

**Files:**
- Modify: `docs/local-usage.md`
- Modify: `PASEO.md`
- Modify: `paseo-plugin/shared/local-config.example.ts`
- Modify: `docs/superpowers/plans/2026-11-08-superagent-flow-canvas.md`

- [x] **Step 1: 运行全套类型检查、测试与构建**
  Run: `pnpm check && git diff --check`

- [x] **Step 2: 使用本机真实状态目录副本或只读挂载做画布冒烟验证**
  验证 `/api/flow/overview` 与真实历史 Ticket 的 `/api/flow/items/ticket/:id` 返回完整三列泳道节点、Worker `agentId`、汇报序列与 Outbox 状态，且无任何敏感 token 泄露。

- [x] **Step 3: 更新本地配置示例与使用说明**
  在 `paseo-plugin/shared/local-config.example.ts`、`docs/local-usage.md` 与 `PASEO.md` 说明 `flowWeb` 开启方式与带 `#token=` 的本机访问方式。

## 实施结果

- Task 1–5 全部完成：`pnpm check` 实测 78 个测试文件 / 1309 个测试通过，typecheck 与三套构建通过。
- 本机真实数据只读冒烟：以只读连接打开现有 `sa-paseo-check` 状态库，识别 8 个 Ticket、11 条请求，真实 Ticket 投影出三列泳道、两个 Worker `agentId`、`ready / completed / sent` 三态与未知项；脱敏断言通过。
- 已在 `paseo-plugin/shared/local-config.ts` 启用 `flowWeb: { enabled: true, port: 17890 }` 并重载 `superagent` 插件；实测 `http://127.0.0.1:17890` 静态 bundle、`/api/flow/overview`（19 条记录：8 个已完成 Ticket、2 条未成单请求）、`/api/flow/items/ticket/:id` 与按需 `/api/flow/transcript/:sessionKey` 全部 200 正常返回，未授权请求返回 401。
