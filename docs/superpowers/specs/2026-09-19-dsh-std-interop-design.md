# dsh-std 互操作接入设计（阶段 A + B）

日期：2026-09-19
状态：待用户评审

## 1. 背景与目标

`@dsh-std`（上游 `Yan-Zero/dsh-std`，由 `T-Auto/dsh-ecosystem-spec` 收录为元协议）
是一套插件 / 宿主 / 运行时之间的声明、发现与协商协议。本设计把 dsh-oc-tui 接入它，
分两个阶段：

- **阶段 A（声明）**：新增静态清单 `dsh-plugin.json` 与 facet 入口 `lib/facet.js`，
  让本插件在不执行代码的前提下可被宿主与 CI 预检；新增 `lib/bridge.js` 作为仓库
  第一个上游抽象层。
- **阶段 B（互操作）**：把 TUI 已有的模态、通知、剪贴板、命令行实现成标准协议的
  提供方，使其他 std 组件可以驱动它们，并使 TUI 成为第三方 UI 贡献的宿主。

已确认的决策（用户 2026-09-19 选择 A+B）：

- 采纳 A + B，不做全量 facet 迁移（见 §4.3）；
- 协议版本全部是 `v1alpha1` / npm `rc`，接受跟踪一个 pre-release 目标的维护成本。

本设计的全部协议细节都已对着**已发布产物**实测，实测记录见 §3。

**实施顺序**（每一步独立可发布、可回滚）：

1. **A** —— 清单 + `lib/bridge.js` + `lib/facet.js` + `package.json`。纯增量，
   不改变任何现有行为，adapter 缺席时完全无感。
2. **B1a** —— Presentation 的 `question` / `approval` / `notification` / `copyText`。
3. **B2** —— CommandRuntime。
4. **B1b** —— Presentation 的 `secret-input`（唯一需要新 UI 的项）。
5. **B3** —— ContributionHost，先只做 Settings 面。

B1a 排在 B2 之前，是因为它复用的现有模态最多、新代码最少，能最早验证
`lib/bridge.js` 的晚绑定契约是否成立。

## 2. 非目标

- **不把 TUI 的生命周期交给 facet。** TUI 仍由 `cordis.patch.yml` 的四行 bundle 激活，
  facet 只是标准协议外壳（§4.1）。这是本设计最重要的约束。
- **不消费 Session 协议。** `session.dsh/v1alpha1` 至今没有标准的消息 / 工具事件词汇
  （上游 `session.zh.md` 把 agent turn、user message、assistant content、tool activity
  列为未决问题）。TUI 的渲染深度依赖 DSH 原生会话事件，改用 std 会让产品退化。
- **不接入 Storage / Tool / Model / Skill / Workspace / Messages 协议。**
- **不声明 conformance。** 上游 `@dsh-std/conformance` 是纯提案，没有任何 fixtures /
  vectors / suite 存在，当前无法声明也无法验证。
- **不向 `dsh-ecosystem-spec` 提交注册。** 该仓库没有 plugin registry，且
  CONTRIBUTING 明确不接受实现代码提交；只有元协议 / 子协议 / 范例实现 / Profile
  四类可挂载。
- 不实现 `OpenExternal` 与 `ExternalRedirect`（见 §6.1）。
- 不引入构建步骤、不引入运行时框架，沿用现有 ESM + `node --check` + 手写测试 harness。

## 3. 协议事实基线（已实测）

### 3.1 版本与分发

`@dsh-std/*` 已发布到 npm，但 **`latest` dist-tag 落后于 git main**，最新版在 `rc` tag 上。
实测（2026-09-19）：

| 包 | npm `latest` | npm `rc`（= 实际最新） |
|---|---|---|
| `@dsh-std/core` | 0.1.0-rc1 | 0.1.1-rc.2 |
| `@dsh-std/manifest` | 0.1.1-rc.2 | 0.1.1-rc.3 |
| `@dsh-std/lifecycle` | 0.1.1-rc.2 | 0.1.1-rc.3 |
| `@dsh-std/sdk` | 0.1.1-rc.2 | 0.1.1-rc.2 |
| `@dsh-std/presentation` | 0.1.0-rc1 | 0.1.1-rc.1 |
| `@dsh-std/command` | 0.1.0-rc2 | 0.1.1-rc.1 |
| `@dsh-std/ui` | 0.1.0-rc1 | 0.1.1-rc.1 |
| `@dsh-std/adapter-dsh` | 0.1.1-rc.2 | 0.1.1-rc.3 |

**因此依赖必须显式 pin `rc` 版本号**，不能写 `^` 或裸包名，否则会装到旧 API。

Node engines 是 `^22.19 || >=24`；本机 v24.18.0 通过；但本仓库 `package.json` 现在写的是
`>=22`，需收紧（§5.4）。

坐标（全部 `v1alpha1`，上游无 Stable，生态索引登记为 Draft）：

| 坐标 | kind | 用途 |
|---|---|---|
| `lifecycle.dsh/v1alpha1` | `FacetModule` | facet 激活 |
| `presentation.dsh/v1alpha1` | `UserInteraction` / `Notification` / `CopyText` / `OpenExternal` / `ExternalRedirect` | UI 调用面 |
| `commands.dsh/v1alpha1` | `Command`（资源）/ `CommandRuntime`（运行时） | 命令 |
| `ui.dsh/v1alpha1` | `ContributionHost` / `UiContribution` | 第三方 UI 贡献 |
| `manifest.dsh/internal/v1alpha1` | `Component` | 清单投影（内部） |
| `community.dsh/v1alpha1` | `Permission` | 权限声明（内部） |

注意 `browser.ui.dsh/v1alpha1` 明确**不适用于 TUI**（上游原文：没有同一 page realm 的
TUI、headless runtime 与 native UI 不需要实现本协议）。

### 3.2 已核实的 API 表面

清单（`@dsh-std/manifest@0.1.1-rc.3`）：

- `manifestVersion` 常量是字符串 `"0.15"`，schema 文件 `schema/dsh-plugin-0.15.schema.json`；
- 顶层 required：`$schema`、`manifestVersion`、`id`、`name`、`version`、`facets`；
- `facets` 是 `additionalProperties: false`，**只有 `host` 一个键**，其 `entry` + `apiVersion` 必填；
- `$schema` 接受任意绝对 URI，加载器**不抓取**它；
- `id` 必须匹配 `^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$`；
- 没有 `supports` 字段。**静态清单只能声明 `requires`，不能声明 support**——support
  只能运行时通过 `context.protocols.implement(...)` 产生；
- `overrides[]` 是 `{target, kind: 'patch'|'native'|'build', description?}`。

facet（`@dsh-std/sdk@0.1.1-rc.2`）：

```ts
defineFacet(activate, deactivate?, snapshot?): FacetModule
// FacetModule = { activate(ctx), deactivate?(reason), snapshot?() }
// 实测返回 { activate, deactivate, snapshot }
```

adapter 侧校验（`packages/adapter-dsh/src/index.ts`）：`assertFacetModule` 只要求
`activate` 是函数；`assertHostCompatibility` 要求 `facets.host.apiVersion` **精确等于**
`'v1alpha1'`。

`FacetProjection = { state?: 'active' | 'degraded', message?, extensions? }` —— 实测
`snapshot()` 返回 `{state:'degraded', message:...}` 与 `{state:'active'}` 均被接受。

Presentation（`@dsh-std/presentation@0.1.1-rc.1`）实测导出确认存在：
`userInteractionImplementation`、`notificationImplementation`、`copyTextImplementation`、
`openExternalImplementation`、`userInteractionSupport`、`notificationSupport`、
`copyTextSupport`、`openExternalSupport`、`register`、`protocols`，以及
`PresentationResult<T> = {status:'submitted',value} | {status:'cancelled'} |
{status:'expired'} | {status:'unavailable',reason?}`。

```js
userInteractionSupport({ operations: ['question','approval','secret-input'] })
// => { apiVersion:'presentation.dsh/v1alpha1', kind:'UserInteraction', spec:{ operations:[...] } }
```

Command（`@dsh-std/command@0.1.1-rc.1`）实测导出确认存在：
`commandRuntimeImplementation`、`CommandRuntimeHandler`、`CommandCatalog`、
`CommandDescriptor`、`CommandSpec`、`extensionDefinition`、`register`。

UI（`@dsh-std/ui@0.1.1-rc.1`）实测导出确认存在：`bindContributionHost`、
`bindContributionHosts`、`contributionHostSupport`、`contributionHostRequirement`、
`UiContributionProvider`、`register`、`registerManifest`。

```ts
interface UiContributionProvider {
  readonly participantId: string
  readonly support: ContributionHostSupportSpec
  register(owner, contribution, context): () => void | Promise<void>   // 必须返回 disposer
}
interface UiContributionDescriptor { id, surface: ApiReference, placement?, content: UiJsonValue }
```

### 3.3 双激活的成因（实测，不是推测）

`@dsh-std/adapter-dsh` 的 `mountProfileComponents(profileDir)`（源码
`packages/adapter-dsh/src/index.ts:1209`）逻辑是：

1. 读 **profile 的** `package.json` 的 `dependencies`；
2. 对每个依赖名解析出 `node_modules/<pkg>/`，若存在 `dsh-plugin.json` 就
   `parseManifest` → `assertHostCompatibility` → `projectManifest`；
3. 对每个激活坐标是 `FacetModule` 的 facet，`import()` 其 `entry`，
   取 `namespace.default ?? namespace.facet`，`assertFacetModule`，然后 `mount()`。

**全过程没有任何"该组件是否已由 cordis bundle 行加载"的检查。**

而 dsh-oc-tui 现在的安装方式是 `dsh plugin --profile tui add dsh-oc-tui`，即它**就是**
profile 的 dependencies 之一，同时由 `cordis.patch.yml` 的 `tui-app` 行激活。

结论：**只要本插件提供 `dsh-plugin.json`，在任何装了 adapter 的 profile 里，TUI 必然被
激活两次**——一次 bundle 行，一次 facet。`lib/index.js` 的 `apply()` 会设置 stdin raw
mode、备用屏、鼠标跟踪并起渲染循环，跑两份是硬故障，不是重复渲染。

这个结论直接决定了 §4.1 的架构决策。

## 4. 架构决策

### 4.1 核心决策：facet 不启动第二个 TUI

facet **不是** TUI 的激活路径。TUI 的生命周期仍归 `cordis.patch.yml` 的 bundle 行所有；
facet 是"活体 TUI 的标准协议外壳"（interop surface），只做两件事：

1. 通过 `context.protocols.implement(support, handler)` 把 TUI 已有的能力发布成标准协议
   support，handler 转发到当前活体 TUI；
2. 通过 `snapshot()` 如实报告状态：有活体 TUI → `active`，没有 → `degraded` 并给出 message。

为什么不能让 facet 自己启动 TUI：

- facet 只拿到 `ActivationContext`（`identity` / `plan` / `scope` / `protocols` /
  `extensions`，实测确认），**拿不到 cordis `ctx`，也拿不到 `Config`**。TUI 需要
  `agents`、`llm`、`sessionPersistence`、`settings`、`sessionQuery`、`attachments`
  以及终端本身，这些都不在 `ActivationContext` 里；
- 若 facet 也启动 TUI → 两份抢占 raw mode / 备用屏 / 鼠标跟踪 → 硬故障；
- adapter 无条件挂载 → 双激活是必然事件，不能靠"注意别装"规避。

这个决策的代价是语义错位：facet 的 `host` 激活坐标意味着"这是组件的激活入口"，而我们
的 facet 实际是外壳。我们用 `snapshot()` 的 `degraded` 状态如实表达它，并在 §10 记录
为已知限制。上游对 `FacetProjection.state` 的定义（`active | degraded`）正好承载这个语义。

### 4.2 活体 TUI 注册表：`lib/bridge.js`

新增 `lib/bridge.js`，是仓库的**第一个上游抽象层**（现在 5 个 `@deepseek-ai/*` 包在
3 个文件里直接 import，`lib/index.js` 2741 行是唯一集成热点）。

```js
// 模块级单例，无依赖，可独立测试
registerLiveTui(handle) -> release()   // 返回幂等的释放函数
liveTui() -> handle | null
```

`handle` 的面（全部由 `lib/index.js` 在 `apply()` 内提供）：

| 成员 | 作用 |
|---|---|
| `interact(request)` | 驱动 `app.pendingApproval` / `app.pendingQuestions` 模态 |
| `notify(request)` | 驱动 `app.showToast` / `app.addSystem` |
| `copyText(request)` | 驱动 `term.copyToClipboard` |
| `commandCatalog(input)` | 列出 TUI 自有命令 |
| `executeCommand(line, input)` | 走现有 `runCommand` |
| `contribute(registration)` | 登记第三方 UI 贡献，返回 disposer |

**晚绑定**：facet 的 handler 在**被调用时**查 `liveTui()`，不在 `activate()` 时捕获。
这样 facet 与 bundle 行的加载顺序无关（adapter 挂载时机取决于 profile 的 cordis 配置），
两种顺序都正确。

`lib/index.js` 侧在 `apply()` 内 `registerLiveTui(handle)`，并用现有的 `ctx.effect(...)`
（`lib/index.js:2726` 已有此模式）在 fiber 卸载时释放。

### 4.3 为什么不做全量 facet 迁移

把 `lib/index.js` 的接线全部改成只消费 std scoped client（即让 facet 真正拥有 TUI）：

- 协议**没有标准的会话事件词汇**，TUI 的消息 / 工具 / 推理渲染会退化成渲染不透明的
  `SessionEventEnvelope`；
- 需要 `SessionCatalog` / `SessionHistory` / `ModelCatalog` / `CommandRuntime` 全套客户端，
  而 adapter 目前只宣称 `list/get/create/rename` + `read/follow`，**不宣称** `delete` /
  `watch` / `fork`（上游 README 明确说明不宣称 DSH 尚未提供同等语义的 operation），
  而 TUI 的 rewind 依赖 fork；
- 收益（写一次跑多端）在只有一个 TUI 前端时不成立。

## 5. 阶段 A：静态清单与 facet 入口

### 5.1 `dsh-plugin.json`

包根新增。以下内容已实测通过 `parseManifest` + `projectManifest`：

```json
{
  "$schema": "https://raw.githubusercontent.com/Yan-Zero/dsh-std/main/packages/manifest/schema/dsh-plugin-0.15.schema.json",
  "manifestVersion": "0.15",
  "id": "io.github.rayafriandion.dsh-oc-tui",
  "name": "dsh-oc-tui",
  "version": "0.1.3",
  "license": "LGPL-3.0-or-later",
  "source": { "repository": "https://github.com/rayafriandion/dsh-oc-tui" },
  "facets": { "host": { "entry": "lib/facet.js", "apiVersion": "v1alpha1" } },
  "requires": {
    "contracts": [
      { "apiVersion": "commands.dsh/v1alpha1", "kind": "Command" }
    ]
  },
  "permissions": [
    { "name": "storage.local.read",  "scope": "io.github.rayafriandion.dsh-oc-tui",
      "reason": "Read TUI settings from the host settings store." },
    { "name": "storage.local.write", "scope": "io.github.rayafriandion.dsh-oc-tui",
      "reason": "Persist TUI settings chosen in the Settings pages." }
  ],
  "contributes": {
    "x-dev.dsh-std.extensions": [
      { "id": "io.github.rayafriandion.dsh-oc-tui.settings",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "settings",
        "spec": { "title": "Open the TUI settings pages",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.help",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "help",
        "spec": { "title": "Show the TUI key and command reference",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.stats",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "stats",
        "spec": { "title": "Show session token and cache statistics",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.new",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "new",
        "spec": { "title": "Start a new session",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.resume",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "resume",
        "spec": { "title": "Resume a persisted session",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.clear",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "clear",
        "spec": { "title": "Clear the transcript",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.cancel",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "cancel",
        "spec": { "title": "Cancel the running turn",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.rewind",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "rewind",
        "spec": { "title": "Rewind the session to an earlier point",
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } },
      { "id": "io.github.rayafriandion.dsh-oc-tui.quit",
        "apiVersion": "commands.dsh/v1alpha1", "kind": "Command", "name": "quit",
        "spec": { "title": "Leave the TUI", "aliases": ["exit"],
                  "placements": [{ "apiVersion": "tui.dsh/v1alpha1", "kind": "CommandLine" }] } }
    ]
  },
  "overrides": [
    { "target": "@deepseek-ai/dsh-base", "kind": "patch",
      "description": "cordis.patch.yml inserts the tui-startup, tui-app, agent-presets and tool-ask-user rows." }
  ]
}
```

关于这份清单的四个决定：

- **`id` 用 `io.github.rayafriandion.dsh-oc-tui`**：命名空间派生自用户实际控制的 GitHub
  owner，比自造的 `dev.*` 更可辩护。
- **`requires.contracts` 只有 `commands.dsh/v1alpha1 Command`**：这是 TUI 唯一静态消费的
  东西（它要读别人贡献的命令）。Presentation 与 ContributionHost 是 TUI **提供**的，
  而 v0.15 清单**没有 `supports` 字段**，support 只能运行时由 `implement()` 产生。
  多写会变成虚假声明。
- **命令走 `x-dev.dsh-std.extensions` 富路径，不走 `contributes.commands`**：实测简单
  路径的投影只有 `{title}`，**不保留 `placements` 和 `aliases`**；而 `placements` 正是
  TUI 用来把自己命令限定在终端命令行的机制（省略 `placements` 意味着"所有命令面都发布"，
  会让 WebUI 也列出 `/settings`）。`aliases: ["exit"]` 保留 `/quit` 与 `/exit` 的等价关系。
- **命令只列 TUI 恒自有的 9 个**：`settings / help / stats / new / resume / clear /
  cancel / rewind / quit`。`/model` 与 `/provider` **故意不列**——`runCommand`
  （`lib/index.js:2527`）会先问 `ctx.commands.find(...)`，harness 注册了同名命令时它们
  归 harness 所有，TUI 只是兜底。列进清单会与 harness 争夺所有权。

### 5.2 `lib/bridge.js`

见 §4.2。约 40 行，零依赖，导出 `registerLiveTui` / `liveTui`。释放函数幂等：
重复调用只生效一次，且只释放"自己注册的那一个"（若已被后来的注册替换则不误删）。

### 5.3 `lib/facet.js`

包根 `dsh-plugin.json` 的 `facets.host.entry` 指向它。**默认导出必须是 `defineFacet(...)`**
（adapter 取 `namespace.default ?? namespace.facet`，且 `assertFacetModule` 会报
"must export defineFacet(...) as default"）。

```js
import { defineFacet } from '@dsh-std/sdk'
import { liveTui } from './bridge.js'

export default defineFacet(
  (context) => { /* 阶段 B：context.protocols.implement(...) */ },
  (reason)   => { /* 释放 implement 的 disposer */ },
  ()         => liveTui()
    ? { state: 'active' }
    : { state: 'degraded', message: 'dsh-oc-tui is activated by its cordis bundle rows; no live TUI instance is registered.' },
)
```

阶段 A 的 facet 就长这样：**可加载、可校验、如实报告、不做任何事**。这是刻意的——
它先让清单与 facet 契约成立，协议实现留给阶段 B。

`@dsh-std/sdk` 用动态 `import()` 加载并 try/catch，而不是顶层静态 import。理由是
**失败模式**，不是语法：`node --check` 只做语法检查、不解析 import，所以静态 import
不会让 `check` 失败；但一旦依赖解析不到（pnpm 严格布局下 `dsh-oc-tui` 不保证能解析到
adapter 自己 `node_modules` 里的 `@dsh-std/sdk`，或测试直接 import 本文件而依赖未装），
静态 import 会**抛错**，而 adapter 的 `mountProfileComponents` 在抛错时会回滚**所有**
已挂载组件——本插件的一个依赖缺失会连累整个 profile 的其他组件。动态 import + try/catch
把这种失败收敛为 `snapshot()` 报 `degraded`。

### 5.4 `package.json` 变更

- `files` 增加 `"dsh-plugin.json"`（否则 npm 包里没有它，adapter 永远找不到）；
- `engines.node` 从 `>=22` 收紧为 `^22.19 || >=24`，与 `@dsh-std/*` 一致；
- `peerDependencies` 增加（全部 `optional: true`，与现有 12 个 peer 的约定一致，
  且 facet 必须在它们缺席时优雅降级）：
  `@dsh-std/sdk`、`@dsh-std/presentation`、`@dsh-std/command`、`@dsh-std/ui`，
  版本显式 pin 到 §3.1 的 `rc` 版本号（**不用 `^`**）；
- `devDependencies` 增加 `@dsh-std/manifest`（测试要跑 `parseManifest` / `projectManifest`）；
- `scripts.check` 增加 `lib/bridge.js` 与 `lib/facet.js`。

## 6. 阶段 B：互操作实现

### 6.1 B1 Presentation（TUI 作为提供方）

映射关系（现有代码位置已核实）：

| std | 现有实现 | 适配工作 |
|---|---|---|
| `UserInteraction.question` | `askQuestions`（`lib/index.js:1072`）+ `app.pendingQuestions`（`lib/ui.js:310`）+ `_paintQuestions`（`lib/ui.js:1997`） | 把 std `QuestionField`（`text`/`select`/`confirm`）适配成 TUI 的 question 形状；把 `QuestionAnswers` 反向适配 |
| `UserInteraction.approval` | `askApproval`（`lib/index.js:1033`）+ `app.pendingApproval`（`lib/ui.js:309`，渲染在 `:1588`） | `risk` / `details[]` 需要新增渲染行（现在只画 toolName + reason） |
| `UserInteraction.secret-input` | `app.settingsSecret`（`lib/ui.js:297, 2236`）是**设置页专用**的掩码字段 | 需要新增一个独立掩码提示模态；掩码渲染逻辑可复用 |
| `Notification` | `app.showToast`（`lib/ui.js:1054`）/ `app.addSystem`（`:724`） | level 映射：std `warning` → TUI `warn`；`deduplicationKey` 需要新增去重 |
| `CopyText` | `term.copyToClipboard`（`lib/term.js:401`） | 见 §7 的 private 处理 |
| `OpenExternal` | 无 | **不实现、不声明**。TUI 不能开浏览器，起进程打开 URL 超出插件权限边界 |
| `ExternalRedirect` | 无 | **不实现、不声明**。需要 loopback HTTP 服务 + 浏览器 |

**B1a**（先落地）：`question` + `approval` + `notification` + `copyText`。
**B1b**（随后）：`secret-input`（需要一个新的独立模态，是 B1 里唯一需要新 UI 的项）。

`notification` 与 `copyText` 的 support 是无 spec 的常量（`notificationSupport` /
`copyTextSupport`），`userInteraction` 需要 `userInteractionSupport({operations:[...]})`。
`operations` 只列**实际实现**的：B1a 阶段是 `['question','approval']`，B1b 之后加上
`'secret-input'`。不实现就不声明——协议明确要求 support 表示"实际可用的实现"。

### 6.2 B2 CommandRuntime（TUI 作为提供方）

- 用 `commandRuntimeImplementation(participantId, { catalog, execute })` 发布
  `commands.dsh/v1alpha1 CommandRuntime`；
- `catalog({ contextId, presentation?, placement })` 返回 TUI 自有命令的
  `CommandDescriptor[]`，按 `placement` 过滤（只认 `tui.dsh/v1alpha1 CommandLine`）；
- `execute({ contextId, line })` 走现有 `runCommand`（`lib/index.js:2514`），
  把 `CommandExecution['result']` 从 `app.addSystem` 的反馈路径取回；
- `contextId` 映射到当前 `currentAgent` 的会话；无会话时（标题屏）返回 `undefined`
  ——协议允许 `execute` 返回 `undefined`。

**已知重复**：命令同时出现在 `dsh-plugin.json` 的静态贡献与 TUI 本地 switch 里。这是
刻意的（静态贡献用于发现与预检，本地 switch 是实际执行路径），但要在 §10 记为限制：
adapter 把 `Command` 扩展映射进 `DshCommandExtensionRegistry` 后，只有当某个产品 UI
注册了匹配 placement 的 `DshCommandSurfaceProvider` 才会把它surface 回来，所以现阶段
不会有"命令出现两次"的用户可见症状。

### 6.3 B3 ContributionHost（TUI 作为宿主）—— 修正：facet 无法实现，已移出范围

> **2026-09-19 修正。** 本节原方案不可实现，实施计划中 B3 已移出范围。原因：
>
> adapter 对传给 `context.protocols.implement()` 的值有强制校验
> （`packages/adapter-dsh/src/index.ts:1774`）——必须有 `handle` 函数、`participantId`
> 必须匹配、`protocol` 必须等于 support。而 `UiContributionProvider` 的形状是
> `{ participantId, support, register }`，既没有 `handle`，字段名也是 `support` 而非
> `protocol`，因此会在挂载时抛错，进而让 `mountProfileComponents` 回滚整个 profile。
> `@dsh-std/ui` 也没有 `*Implementation` 工厂可供包一层。
>
> UI 贡献宿主的真实注册入口是 adapter 的实例方法
> `DshStandardAdapter.registerUiContributionProvider(provider)`，而 facet 只拿到
> `ActivationContext`，**拿不到 adapter 实例**。所以这是宿主级钩子，不是 facet 激活面
> 的一部分。后续若要做，正确落点是 cordis 侧：adapter 注册为 cordis 服务 `dshStd`，
> `lib/index.js` 可用既有的 `ctx.get('dshStd')` 模式调用它——但那需要 adapter 作为
> 依赖才能测试，是独立的一块工作。
>
> 下面保留原始方案文本，仅作为当时的推理记录，**不要照此实现**。

原方案（不可实现，勿照抄）：

- 实现 `UiContributionProvider`：`{ participantId, support: contributionHostSupport(spec),
  register(owner, contribution, context) }`，`register` **必须返回 disposer**；
- `support` 的 `surfaces` 只声明 TUI 真正能渲染的面。**第一期只做 Settings 面**
  （用 `placement` 区分），因为 Settings 菜单（`lib/web-settings.js` 的 `SETTINGS_MENU`）
  已有稳定的分区渲染；主面板 / 状态栏留到后续。Settings 面内的具体落点见 §11 第 1 项；
- `contribute(registration)` 进入 §4.2 的 handle，由 `lib/ui.js` 在对应位置渲染
  `descriptor.content`（`UiJsonValue`，只支持 `host-rendered` 模式）；
- `local-module` 模式**不支持**：它要求宿主 import 并执行第三方 JS，而 TUI 无沙箱、
  且协议自己说"没有同一 page realm 的 TUI 不需要实现"。只声明 `host-rendered`。

### 6.4 明确不做的协议

Session、Storage、Tool、Model、Skill、Workspace、Messages、Permission、Events、
Provenance、Conformance、`agent.dsh`（上游无包）、`browser.ui.dsh`（不适用 TUI）。
理由见 §2。

## 7. 错误与边界

- **无活体 TUI**：所有 Presentation handler 返回 `{ status: 'unavailable', reason: '...' }`。
  协议规定 UI 可以把 `unavailable` 隐藏，但**不能**把它当默认同意——审批场景尤其重要，
  返回 `unavailable` 绝不能变成 `approved`。
- **`CopyText` 的 `sensitivity: 'private'`（安全问题）**：`lib/term.js:401` 的
  `copyToClipboard` 在 Windows 上有一个 PowerShell 回退，它把**文本的 base64 作为命令行
  参数**传给 `powershell.exe`（`lib/term.js:416`）。同用户的其他进程可以读到该命令行，
  因此对 `sensitivity: 'private'` 必须**只走 OSC 52**、跳过回退。实现方式：给
  `copyToClipboard(text, { osc52Only })` 加一个选项，默认行为不变。
- **`deadline`**：std 请求带 `deadline`，TUI 的 `askApproval` / `askQuestions` 已有
  `req.signal` 的 abort 处理（`lib/index.js:1041`），复用它；deadline 到期走
  `{ status: 'expired' }`。
- **未知 kind / 未知 surface**：不注册、不渲染，不报错。
- **adapter 未安装**：`dsh-plugin.json` 与 `lib/facet.js` 都不被加载，行为与今天完全一致。
- **facet 加载但无 bundle 行**：`snapshot()` 报 `degraded`，`liveTui()` 为 `null`，
  所有 handler 返回 `unavailable`。TUI 不启动。
- **协议包版本漂移**：pin 到 `rc` 具体版本；`lib/facet.js` 用 try/catch 包住动态 import，
  版本不兼容时降级为 `degraded` 而不是让 adapter 的 `mountProfileComponents` 整体抛错
  （它会回滚已挂载的所有组件）。

## 8. 测试计划

沿用现有 `tests/smoke.test.mjs` 的 `eq()` / `ok()` 手写 harness，不引入测试框架；
新增纯函数优先、可注入依赖。

新增断言：

1. **清单有效性**：`parseManifest(JSON.stringify(manifest))` + `projectManifest(...)` 不抛错；
   投影出的 facet 激活坐标是 `lifecycle.dsh/v1alpha1 FacetModule`；`requires.contracts`
   恰为一条 `commands.dsh/v1alpha1 Command`；每个命令扩展的 `spec.placements` 都等于
   `tui.dsh/v1alpha1 CommandLine`；`id` 与 `version` 与 `package.json` 一致（防止发版时漏改）。
2. **bridge 晚绑定**：两种顺序各测一遍——先 `registerLiveTui` 再建 facet，与先建 facet
   再 `registerLiveTui`——handler 都必须在调用时看到活体 TUI。
3. **bridge 释放幂等**：`release()` 调两次不报错；被后来的注册替换后，旧 `release()`
   不得清掉新的。
4. **facet 状态**：无活体 → `snapshot()` 返回 `state: 'degraded'`；有活体 → `'active'`。
5. **Presentation 适配纯函数**：`QuestionField` → TUI question 形状的双向转换；
   `level` 映射（`warning` → `warn`）；无活体时返回 `unavailable`（并断言**不是**
   `approved`）。
6. **private 复制路径**：`copyText({sensitivity:'private'})` 不触发 PowerShell 回退
   （注入假的 `spawn` 记录调用）。
7. **`lib/facet.js` 默认导出形状**：`typeof default.activate === 'function'`，
   满足 `assertFacetModule`。

`tests/render.test.mjs` / `tests/rewind.test.mjs` 不受影响。

## 9. 文档更新

- `README.md`：新增一节说明 dsh-std 接入的范围与**双激活已由设计规避**（否则下一个人
  会以为是 bug）；
- `docs/用户手册.md`：如果 B3 的 Settings 贡献面落地，补一节"第三方插件往设置页加东西"；
- 新增 `docs/dsh-std-接入说明.md`：清单字段含义、pin 的版本、`lib/bridge.js` 的契约、
  以及"facet 不拥有 TUI 生命周期"这条约束的原因；
- `package.json` 的 `keywords` 可加 `dsh-std`。

## 10. 已知限制与风险

1. **语义错位**：manifest 的 `facets.host.entry` 名义上是组件激活入口，实际是互操作外壳。
   靠 `snapshot()` 的 `degraded` 如实表达。这是 §4.1 决策的直接代价。
2. **命令双份**：静态贡献 + 本地 switch（§6.2）。当前无用户可见症状，但 adapter 若改变
   surface 回传行为就会显现。
3. **无法声明 conformance**：上游没有 suite，只有提案。
4. **无法注册进 ecosystem-spec**：该仓库没有 plugin registry。
5. **跟踪 pre-release**：所有坐标 `v1alpha1`、npm 版本 `rc`、`latest` tag 落后。
   上游改 API 会直接打到我们。这是采纳 A+B 时已知并接受的成本。
6. **`OpenExternal` / `ExternalRedirect` / `local-module` 贡献面永久缺席**，
   意味着依赖这三者的 std 组件在 TUI 里不可用（它们会看到 `unavailable`）。
7. **TUI 独占终端**：它设置 raw mode、备用屏、鼠标跟踪，因此必须是唯一的
   ContributionHost，不能与另一个交互式 UI 共存。这是既有事实，不是本设计引入的。

## 11. 未决问题

以下两项在实现时需要拍板，本设计给出建议值：

1. **B3 的 Settings 贡献面具体渲染位置**：建议先只支持"在 Settings 菜单末尾追加一个
   只读分区"，把写入型贡献（第三方要往 settings 里存东西）留到下一期，因为写入需要
   `storage` 协议配合，而本设计不接入 Storage。
2. **是否给 `compat.hosts` 声明 `["dsh"]`**：建议**暂不声明**。它的语义（host 标识符
   如何匹配）没有在已发布产物里被验证过，声明一个没被校验的字段属于过度声称。

## 12. 修订

（暂无）
