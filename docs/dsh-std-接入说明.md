# dsh-oc-tui 的 @dsh-std 接入说明

本文写给两类读者：

- **本仓库的维护者**：这里记录的是设计约束，不是实现笔记。任何一条被打破，都会以「TUI 起不来」或「整个 profile 回滚」的形式暴露，而不是一条测试失败。
- **插件作者**：这里说明 dsh-oc-tui 在 `@dsh-std` 生态里提供什么、消费什么、以及**明确不提供**什么，以免你把一个 `unavailable` 当成 bug 来查。

设计依据是 `docs/superpowers/specs/2026-09-19-dsh-std-interop-design.md`，实施计划是 `docs/superpowers/plans/2026-09-19-dsh-std-interop.md`。本文只描述已经落地的行为。

---

## 阻断性发现：本插件当前不发布任何协议 support

**这是上游缺口，不是本插件的缺陷，但它决定了本文其余部分该怎么读：Phase A（静态清单与预检）成立并且可交付；Phase B（运行时协议互操作）在当前上游版本下处于休眠状态。** 已逐层核实（2026-09-20）：

1. `@dsh-std/lifecycle` 的 `implement` 就是 `stageProtocol`（`node_modules/@dsh-std/lifecycle/lib/index.js:214-231`）：它要求 support 已出现在该 facet **自己投影**的 `protocols.supports` 里，否则抛 `TypeError: facet attempted to implement undeclared protocol ...`。
2. `@dsh-std/adapter-dsh@0.1.1-rc.3` 用 `LifecycleCoordinator` 构造 `ActivationContext`（`lib/index.js:1234`），**没有**自己定义 `implement`——所以交给 facet 的就是上面那个 `stageProtocol`。
3. adapter 里**没有任何**代码路径把 `protocols.supports` 写到 facet 上：Community v0.15 路线经 `projectManifest` 只产出 `protocols.requires`；adapter 自己的 facet 构造（`lib/index.js:1678`）同样只设 `requires`。
4. Community v0.15 清单**无法**声明 supports：`requires.supports` 与顶层 `supports` 都被 schema 以 `unknown field` 拒绝（已实测）。

**后果不是「互操作少了一块」，而是会破坏整个 profile。** 若 facet 照旧调用 `implement()`，第一次调用就抛 `TypeError`，激活实例转入 `failed`；而 adapter 的 `mountProfileComponents` 一旦抛错，会回滚 profile 里**全部**已挂载组件——本插件的一个声明缺口会连累同 profile 的其它组件。§2.3 与 §4.3 那条「facet 绝不启动 TUI」的硬约束保护的是双激活；这里的守卫保护的是**整个 profile**，两者不是一回事。

**守卫做了什么。** `lib/facet.js` 的 `activate()` 现在先读自己投影里的 supports：为空就**不暂存任何实现、直接返回**（0 次 `implement()`、0 次 `scope.add()`），并让 `snapshot()` 报告 `degraded` 与原因。这一行为已对着**真实清单投影**实测（0 个实现被暂存），也对着一个**假设声明了四条 support** 的清单实测过（四条全部正常暂存）。

**这意味着什么：**

- **Phase A 是本分支可交付的部分**：静态 `dsh-plugin.json`、发现与预检（不执行插件代码即可被宿主与 CI 读取）完全不受影响。
- **Phase B 是休眠，不是缺失。** `lib/std/presentation.js`、`lib/std/commands.js`、`lib/std/adapt.js` 都已写好并被测试覆盖，facet 只是不暂存它们。**上游一旦允许 v0.15 组件声明 supports，同一份代码原样生效**，本文任何一行都不用改。
- **§2 的双激活结论不受影响**：facet 依然不启动 TUI，这条约束与上面的缺口无关。
- 因此下文凡说「提供」某协议的地方，说的都是**代码具备该能力**；在当前上游上，实际暂存的数量是 **0**。§1、§6、§7.1 已按此加注。

---

## 1. 本插件的角色：Host 与 Presentation 提供方

dsh-oc-tui **不是协议消费方**，而是生态里**设计为提供方（provider）**。它的设计意图是把终端里已有的模态、通知、剪贴板和命令行发布成标准协议，让其他 std 组件来驱动它们——但**当前上游下一条都发布不出去**，见开头的阻断性发现。

| 坐标 | 角色 | 具体内容 |
| --- | --- | --- |
| `presentation.dsh/v1alpha1` `UserInteraction` | **提供（当前休眠）** | `operations: ['question', 'approval', 'secret-input']` |
| `presentation.dsh/v1alpha1` `Notification` | **提供（当前休眠）** | 无 spec 常量 support |
| `presentation.dsh/v1alpha1` `CopyText` | **提供（当前休眠）** | 无 spec 常量 support |
| `commands.dsh/v1alpha1` `CommandRuntime` | **提供（当前休眠）** | `catalog` / `execute`，只服务 `tui.dsh/v1alpha1 CommandLine` 这一个 placement |
| `commands.dsh/v1alpha1` `Command` | **消费（静态声明）** | TUI 读取别人贡献的命令；这是 `requires.contracts` 里唯一的一条 |

上表的「提供」描述的是**代码具备的能力**，不是当前的运行时状态：这些 support 只有在 facet 自己的投影声明了它们之后才会被暂存（`context.protocols.implement(...)`，见 §6），而 Community v0.15 清单无法声明 supports——**当前实际暂存 0 条**。详见开头的[阻断性发现](#阻断性发现本插件当前不发布任何协议-support)。`OpenExternal`、`ExternalRedirect` 不提供（见 §7）。

`browser.ui.dsh/v1alpha1` 对本插件**不适用**：上游明确说明没有同一 page realm 的 TUI、headless runtime 与 native UI 不需要实现该协议。

---

## 2. 为什么 facet 不拥有 TUI 的生命周期

这是整个接入里最重要的一条约束。

### 2.1 双激活是必然事件，不是可以靠小心规避的事故

`@dsh-std/adapter-dsh` 的 `mountProfileComponents(profileDir)` 的逻辑是：

1. 读 **profile 的** `package.json` 的 `dependencies`；
2. 对每个依赖名解析 `node_modules/<pkg>/`，只要存在 `dsh-plugin.json`，就 `parseManifest` → `assertHostCompatibility` → `projectManifest`；
3. 对每个激活坐标是 `FacetModule` 的 facet，`import()` 它的 `entry`，取 `namespace.default ?? namespace.facet`，`assertFacetModule` 之后挂载。

**全过程没有任何「该组件是否已由 cordis bundle 行加载」的检查。**

而 dsh-oc-tui 的安装方式就是 `dsh plugin --profile tui add dsh-oc-tui`，即它**本身就是** profile 的 `dependencies` 之一，同时又由 `cordis.patch.yml` 的 `tui-app` 行激活。所以在任何装了 adapter 的 profile 里，只要本插件提供 `dsh-plugin.json`，TUI 就**必然**被激活两次。

TUI 会抢占终端：设置 stdin raw mode、备用屏、鼠标跟踪，并启动渲染循环。跑两份不是「重复渲染」，而是硬故障——两份互抢终端状态。

### 2.2 结论：facet 是互操作外壳（interop shell）

`lib/facet.js` **不是** TUI 的激活路径。TUI 的生命周期仍归 `cordis.patch.yml` 的四行 bundle 所有；facet 只做两件事：

1. 通过 `context.protocols.implement(support, handler)` 把 TUI 已有的能力发布成标准协议 support（**仅当投影声明了这些 support 时**，见开头的阻断性发现），handler 通过 `lib/bridge.js` 转发到当前活体 TUI；
2. 通过 `snapshot()` 如实报告状态：只有「有活体 TUI」**且**「本 facet 确实暂存了协议」才返回 `{ state: 'active' }`；否则返回 `{ state: 'degraded', message: '...' }`，message 区分两种原因——没有活体 TUI，或没有可暂存的 support（见开头的阻断性发现）。

`snapshot()` 返回的 `degraded` 是**正常状态**，不是错误，而且有**两种**成因，各带自己的 message：

- **没有活体 TUI**：facet 被挂载了，但 TUI 不是由它启动的，此刻也没有活体实例可供转发；
- **没有可暂存的 support**：facet 自己的投影没有声明任何 support，于是它一条都不暂存——这是当前上游下的实际情况，见开头的阻断性发现。

上游对 `FacetProjection.state` 的定义（`active | degraded`）正好承载这两者的语义。

### 2.3 为什么不能让 facet 自己启动 TUI

除了双激活之外，facet 也**没有能力**启动 TUI：

- facet 只拿到 `ActivationContext`（`identity` / `plan` / `scope` / `protocols` / `extensions`），**拿不到 cordis `ctx`，也拿不到 `Config`**。而 TUI 需要 `agents`、`llm`、`sessionPersistence`、`settings`、`sessionQuery`、`attachments` 以及终端本身，这些都不在 `ActivationContext` 里；
- 若 facet 也启动 TUI，两份会互抢 raw mode / 备用屏 / 鼠标跟踪。

因此 `lib/facet.js` 里**没有**任何调用 `lib/index.js` 的 `apply()` 的路径，这是硬约束，不是当前实现状态。

### 2.4 无活体 TUI 时的行为

所有 Presentation handler 在 `liveTui()` 为 `null` 时返回 `{ status: 'unavailable', reason: '...' }`。协议允许 UI 把 `unavailable` 隐藏，但**绝不能**把它当成默认同意——审批场景尤其如此：`unavailable` 在任何情况下都不会变成 `approved`。`approvalOutcome()` 对任何非决定值（`cancelled`、未知值、`undefined`、`null`、truthy 非决定值）一律返回 `{ status: 'cancelled' }`。

---

## 3. `dsh-plugin.json` 各字段

这是唯一被 adapter 与 CI 静态读取的声明面。它必须进 npm 包（`package.json` 的 `files` 白名单里已有它），否则 adapter 永远找不到。

### 3.1 字段含义

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `$schema` | 指向上游 `dsh-plugin-0.15.schema.json` 的绝对 URI | 加载器**不抓取**它，只作为编辑期提示 |
| `manifestVersion` | `"0.15"`（字符串） | Community 清单版本；schema 文件即 `dsh-plugin-0.15.schema.json` |
| `id` | `io.github.rayafriandion.dsh-oc-tui` | 必须匹配 `^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$`；命名空间派生自实际控制的 GitHub owner |
| `name` / `version` / `license` | `dsh-oc-tui` / `0.1.3` / `LGPL-3.0-or-later` | `version` 与 `license` 必须与 `package.json` 一致，测试会交叉校验 |
| `source.repository` | 仓库地址 | 仅元数据 |
| `facets` | 只有 `host` 一个键 | `facets` 是 `additionalProperties: false`，`entry` 与 `apiVersion` 必填；`apiVersion` 必须**精确等于** `v1alpha1`（adapter 是精确匹配，不是 semver） |
| `requires.contracts` | 一条 `commands.dsh/v1alpha1 Command` | 见 §3.2 |
| `permissions` | `storage.local.read` / `storage.local.write`，`scope` 为本组件 id | 权限声明。TUI 的设置读写走宿主的 `ctx.settings`（持久化到 `$DSH_HOME/settings.yaml`），**不是** std 的 Storage 协议——本插件不接入 Storage（见 §7） |
| `contributes` | `x-dev.dsh-std.extensions` 下的 9 条 Command | 见 §3.3 |
| `overrides` | 一条 `{ target: "@deepseek-ai/dsh-base", kind: "patch" }` | `target` 是**被 patch 的宿主层**，不是本插件的仓库地址：`cordis.patch.yml` 的四行是在 `@deepseek-ai/dsh-base` 之上追加的 |

投影结果（`projectManifest`）：facet 的激活坐标是 `lifecycle.dsh/v1alpha1` / `FacetModule`，`spec.module` 为 `lib/facet.js`；`requires.contracts` 变成该 facet 的 `spec.protocols.requires`。

### 3.2 为什么 `requires.contracts` 只有 `Command`

`commands.dsh/v1alpha1 Command` 是 TUI **唯一静态消费**的东西：它要读别人贡献的命令。

Presentation 是 TUI **提供**的（ContributionHost **不在其中**：本插件不注册贡献宿主，`@dsh-std/ui` 也没有可供 facet 使用的实现工厂，见 §7.2）。而 Community v0.15 的清单**没有 `supports` 字段**——静态清单只能声明 `requires`，不能声明 support。support 只能运行时通过 `context.protocols.implement(...)` 产生，**而运行时这条路当前也是关的**：`implement()` 只接受 facet 投影里已声明的 support，清单既不能声明，投影里自然没有（见开头的阻断性发现）。把提供的协议写进 `requires.contracts` 会变成**虚假声明**：那是在说「我需要别人提供它」，与事实相反。

### 3.3 为什么命令走 `x-dev.dsh-std.extensions` 富路径

清单有两条可走的路：简单的 `contributes.commands` 与富扩展点 `contributes["x-dev.dsh-std.extensions"]`。本插件走后者，因为**简单路径的投影会丢字段**。

实测 `@dsh-std/manifest` 的 `projectCommunityManifest`：`contributes.commands` 的每一行只投影出 `{ title, description? }`，`placements` 与 `aliases` 全部丢弃。而：

- `placements` 正是 TUI 用来把自己命令限定在终端命令行的机制。**省略 `placements` 意味着「所有命令面都发布」**，会让 WebUI 也列出 `/settings`、`/rewind` 这些它无法执行的命令；
- `aliases: ["exit"]` 保留 `/quit` 与 `/exit` 的等价关系。

富扩展点则把 `spec` 原样投影（`spec: contribution.spec`），因此 `placements` 与 `aliases` 都能保留。测试断言每条命令的 `spec.placements` 都恰好是 `tui.dsh/v1alpha1 CommandLine`。

产品自有坐标用 `tui.dsh/v1alpha1`，符合生态治理规定。

### 3.4 命令只列 TUI 恒自有的 9 个

`settings / help / stats / new / resume / clear / cancel / rewind / quit`。

`/model` 与 `/provider` **故意不列**：`runCommand` 会先问 `ctx.commands.find(...)`，harness 注册了同名命令时它们归 harness 所有，TUI 只是兜底。列进清单会与 harness 争夺所有权。

### 3.5 依赖为什么 pin 到精确 `rc` 版本

`@dsh-std/*` 已发布到 npm，但 **npm 的 `latest` dist-tag 落后于 git main**，最新版在 `rc` tag 上。写 `^` 或裸包名会装到更旧的 API。实测（2026-09-19）：

| 包 | npm `latest` | npm `rc`（= 实际最新） |
| --- | --- | --- |
| `@dsh-std/core` | 0.1.0-rc1 | 0.1.1-rc.2 |
| `@dsh-std/manifest` | 0.1.1-rc.2 | 0.1.1-rc.3 |
| `@dsh-std/lifecycle` | 0.1.1-rc.2 | 0.1.1-rc.3 |
| `@dsh-std/sdk` | 0.1.1-rc.2 | 0.1.1-rc.2 |
| `@dsh-std/presentation` | 0.1.0-rc1 | 0.1.1-rc.1 |
| `@dsh-std/command` | 0.1.0-rc2 | 0.1.1-rc.1 |
| `@dsh-std/ui` | 0.1.0-rc1 | 0.1.1-rc.1 |
| `@dsh-std/adapter-dsh` | 0.1.1-rc.2 | 0.1.1-rc.3 |

本仓库实际 pin 的版本（**不带 `^`**）：

| 包 | 版本 | 位置 |
| --- | --- | --- |
| `@dsh-std/sdk` | `0.1.1-rc.2` | peer（optional）+ dev |
| `@dsh-std/presentation` | `0.1.1-rc.1` | peer（optional）+ dev |
| `@dsh-std/command` | `0.1.1-rc.1` | peer（optional）+ dev |
| `@dsh-std/ui` | `0.1.1-rc.1` | peer（optional）+ dev |
| `@dsh-std/manifest` | `0.1.1-rc.3` | 仅 dev（测试用 `parseManifest` / `projectManifest`） |

**peer 和 dev 都要有，是有意的。** `peerDependenciesMeta` 里标了 `optional: true` 的 peer，npm **不会**安装——这正是想要的运行时行为（facet 必须在它们缺席时降级为 `degraded`）。但测试会真的调用 `facet.activate(context)` 并断言注册了哪些协议，那就必须能真正 `import('@dsh-std/presentation')`。只声明 optional peer 而不声明 devDependency，那些测试必然失败。两边用同一批精确版本，避免测试对着与运行时不同的版本通过。

`engines.node` 也从 `>=22` 收紧为 `^22.19 || >=24`，与 `@dsh-std/*` 一致。

---

## 4. `lib/bridge.js` 的契约

`lib/bridge.js` 是仓库里第一个上游抽象层，也是「TUI 实例在哪」的**唯一**真相来源。

```js
registerLiveTui(handle) -> release()   // 注册当前活体 TUI，返回幂等释放函数
liveTui()               -> handle | null
```

零依赖、模块级单例。

### 4.1 晚绑定

facet 的 handler 在**被调用时**查 `liveTui()`，**不在** `activate()` 时捕获句柄。原因是 adapter 的挂载时机取决于 profile 的 cordis 配置，与 bundle 行的加载顺序**没有保证**：可能 facet 先挂载、TUI 后启动，也可能相反。晚绑定让两种顺序都正确。

测试覆盖的是**一种**顺序：先创建 handler / 工厂，再 `registerLiveTui`，最后调用——这恰好是能抓住早绑定的一种（若实现在创建时就捕获句柄，断言会立刻失败）。**反过来的顺序（先注册句柄、再创建 handler / 工厂）没有测试**：它在早绑定与晚绑定两种实现下都会通过，所以不是必需的判别用例，但目前确实没有覆盖。

### 4.2 幂等释放，且不得清掉更新的注册

`release()` 重复调用只生效一次；并且只有当**自己注册的那一个**仍是当前注册时才清空——后来的注册必须能活过旧注册的卸载。

```js
export function registerLiveTui(handle) {
  active = handle
  let released = false
  return () => {
    if (released) return
    released = true
    if (active === handle) active = null
  }
}
```

`lib/index.js` 在 `apply()` 内注册句柄，并用**既有的** `ctx.effect(...)` 清理函数（与 `term.stop()` 同一个 effect）在 fiber 卸载时调用 `releaseLiveTui()`。

### 4.3 硬约束：facet 绝不启动 TUI

理由见 §2.3。`lib/facet.js` 只做协议注册与状态上报。

`lib/facet.js` 用**动态 `import()` + try/catch** 加载 `lib/std/presentation.js` 与 `lib/std/commands.js`，而不是顶层静态 import。理由是**失败模式**：`@dsh-std/presentation` 与 `@dsh-std/command` 是 optional peer，一旦解析不到，adapter 的 `mountProfileComponents` 会在抛错时**回滚整个 profile 里所有已挂载组件**——本插件的一个依赖缺失会连累别人。动态 import + try/catch 把这种失败收敛为「这个 facet 少发布一条协议」，`activate()` 仍然正常返回。

`@dsh-std/sdk` 在 `package.json` 里作为 peer 声明，但 **`lib/` 里没有任何模块消费它**，facet 也不做 sdk 存在性探测：`lib/std/presentation.js` 只需要 `../bridge.js` 与 `@dsh-std/presentation`，一个多余的探测反而会在「sdk 缺席但 presentation 存在」时错误地压制全部注册。

---

## 5. 不可破坏的不变量：`lib/index.js` 的 import 图不含 `@dsh-std/*`

`lib/index.js` 是 `cordis.patch.yml` 里 `tui-app` 行的入口，**每个** profile 启动时都会加载它。而 `@dsh-std/*` 是 `optional: true` 的 peer，npm **不会**安装。

因此：**`lib/index.js` 直接或间接静态 import 的任何模块，都不得在模块作用域 import `@dsh-std/*`。** 一旦缺席，`lib/index.js` 会在模块加载期就失败，**TUI 完全起不来**。facet 的 try/catch 救不了——bundle 行先于 facet 加载。

当前状态（已核对）：

- **`lib/` 下**静态 import `@dsh-std/*` 的只有两个文件：`lib/std/presentation.js`（`@dsh-std/presentation`）与 `lib/std/commands.js`（`@dsh-std/command`）。两者都**只**被 `lib/facet.js` 的动态 import 加载。（`tests/std.test.mjs` 也静态 import `@dsh-std/manifest`，但那只是 devDependency，不在运行时的 import 图上。）
- `lib/index.js` 的本地 import 链上有 `lib/bridge.js`（0 个 peer）、`lib/std/adapt.js`（0 个）、`lib/std/command-list.js`（0 个）；
- **纯数据放在零依赖模块 `lib/std/command-list.js`**：`COMMAND_PLACEMENT`、`TUI_OWNED_COMMANDS`、`COMMAND_DESCRIPTIONS`。`lib/std/commands.js` 从它 import 并再导出，所以协议侧仍是这些数据的单一入口。

新增任何 `lib/index.js` 的 import 之前，先确认其整条传递链上没有 `@dsh-std/*`。

---

## 6. adapter 的 staging 契约：必须来自协议包自己的工厂

adapter 对传给 `context.protocols.implement(support, value)` 的值有**强制校验**（`@dsh-std/adapter-dsh` 的 `capabilityImplementation`）：

- `value.handle` 必须是函数；
- `value.participantId` 必须等于该 facet 的激活 participant id；
- `value.protocol` 必须等于所声明的 support。

三条全部强制。手搓的 `{ interact, notify, copyText }` 或 `{ catalog, execute }` 会在挂载时抛错，而 `mountProfileComponents` 一旦抛错就**回滚 profile 里所有已挂载组件**。

所以工厂不是便利，是契约：

- `lib/std/presentation.js` 用 `userInteractionImplementation` / `notificationImplementation` / `copyTextImplementation`（来自 `@dsh-std/presentation`）；
- `lib/std/commands.js` 用 `commandRuntimeImplementation`（来自 `@dsh-std/command`）；
- `participantId` 一律取自 `context.identity.participantId`，不硬编码；
- 注册形式是 `context.protocols.implement(implementation.protocol, implementation)`。

测试把这三条属性都钉住（participantId 回环、`typeof handle === 'function'`、`protocol` 等于 support）。

**推论：任何值交给 `implement()` 之前，先确认协议包提供了 `*Implementation` 工厂。** 没有工厂的协议不是 facet 能提供的（B3 ContributionHost 正是这种情况，见 §7）。

**注意：本节描述的是「若要暂存，必须满足什么」的契约，不是当前发生的事。** 在当前上游下，上面这些 `implement()` 调用**一次都不会发生**——facet 的投影没有声明任何 support，守卫在到达 §6 之前就返回了（见开头的阻断性发现）。这套契约依然有效：上游放开声明之后，本节列出的四条工厂接线原样生效。

---

## 7. 当前不实现的部分与原因

### 7.1 Presentation

| 协议 | 原因 |
| --- | --- |
| `OpenExternal` | TUI 不能开浏览器；起进程打开 URL 超出插件权限边界。不实现、不声明 |
| `ExternalRedirect` | 需要 loopback HTTP 服务加浏览器，TUI 两者都没有 |

`UserInteraction.operations` 只列**代码实际实现**的三个：`question`、`approval`、`secret-input`。协议明确要求 support 表示「实际可用的实现」，不实现就不声明。这三个操作在 `lib/std/presentation.js` 与 `lib/index.js` 里都有实现并被测试覆盖，但**在当前上游上不会被发布出去**——facet 不暂存任何 support（见开头的阻断性发现），所以这份操作列表目前只在测试里成立。

### 7.2 UI 贡献

- `local-module` 贡献模式**不支持**：它要求宿主 import 并执行第三方 JS，而 TUI 无沙箱；协议自己说没有同一 page realm 的 TUI 不需要实现它。只有 `host-rendered` 模式是可考虑的。
- **B3 ContributionHost 已移出范围。** 原因有两层：
  1. `@dsh-std/ui` **没有 `*Implementation` 工厂**可供包一层，而 `UiContributionProvider` 的形状是 `{ participantId, support, register }`——既没有 `handle`，字段名也是 `support` 而非 `protocol`，因此会被 §6 的校验拒绝，进而让 `mountProfileComponents` 回滚整个 profile；
  2. UI 贡献宿主的**真实注册入口**是 adapter 的实例方法 `DshStandardAdapter.registerUiContributionProvider(provider)`，而 facet 只拿到 `ActivationContext`，**拿不到 adapter 实例**。

  所以这是**宿主级钩子**，不是 facet 激活面的一部分。后续若要做，正确落点在 cordis 侧：adapter 注册为 cordis 服务，`lib/index.js` 用既有的 `ctx.get(...)` 模式调用它——但那需要 adapter 作为依赖才能测试，是独立的一块工作。

  > 设计文档 §6.3 保留了原始方案文本，并标注「不要照此实现」。那是当时的推理记录，不是待办。

### 7.3 其他协议

Session、Storage、Tool、Model、Skill、Workspace、Messages、Permission、Events、Provenance、Conformance、`agent.dsh`、`browser.ui.dsh` 一律不接入。

- **Session 的理由最值得记住**：`session.dsh/v1alpha1` 至今没有标准的消息 / 工具事件词汇（上游 `session.zh.md` 把 agent turn、user message、assistant content、tool activity 列为未决问题）。TUI 的渲染深度依赖 DSH 原生会话事件，改用 std 会让产品退化。
- **Storage**：TUI 的设置走宿主 `ctx.settings`，不需要 std 的 Storage 协议。

### 7.4 这样做的代价

依赖 `OpenExternal` / `ExternalRedirect` / `local-module` 贡献的 std 组件在 TUI 里**不可用**，它们会看到 `unavailable` 或根本没有匹配的 support。这是刻意的取舍，不是遗漏。

---

## 8. 当前无法声称的事

**首先，也是最根本的一条：本插件当前不发布任何协议 support**，因此不能声称自己已在运行时与 `@dsh-std` 互操作（见开头的阻断性发现）。下面两条是另外两个边界。

1. **无法声明 conformance。** 上游 `@dsh-std/conformance` 是纯提案，没有任何 fixtures / vectors / suite 存在，当前既无法声明也无法验证。
2. **无法注册进 `dsh-ecosystem-spec`。** 该仓库没有 plugin registry，且其 CONTRIBUTING 明确**不接受实现代码提交**；可挂载的只有元协议 / 子协议 / 范例实现 / Profile 四类。所以本插件只能被 adapter 按 profile 依赖发现，不能出现在生态索引里。

另外，所有坐标都是 `v1alpha1`、npm 版本都是 `rc`，上游改 API 会直接打到本插件。这是采纳本方案时已知并接受的成本。

---

## 9. 已知行为（known properties）

以下 §9.1–§9.7 每条都是**刻意的**，并且经过代码评审确认。不了解它们的人会把它们读成 bug。

**§9.8 是例外**：那里列的是开放缺口——一项上游阻断加三项尚未完成的设计项——不是既定行为，不应被当作已支持的能力。

**还有一处范围提示**：§9.1–§9.5 描述的是 `lib/std/adapt.js` 与 std 协议 handler（`interact` / `commandRuntime`）上的行为，而那条路径在当前上游下是休眠的（见开头的阻断性发现）。它们描述的是**代码行为**，目前不是用户可见的行为。§9.6 的 `TUI_OWNED_COMMANDS` 与 §9.7 的 Esc 委托走的是 TUI 自己的路径，不受影响。

### 9.1 只填自由文本的多选字段，整个字段丢失

标准答案类型是 `string | boolean | readonly string[]`，**没有**「选项加自由文本」的槽位。TUI 的多选在用户同时选了选项又填了自由文本时，`selected` 仍然有值，而数组是**可表示的那一半**，所以 `fromTuiAnswers` 取数组、丢掉文本。

但如果用户**只**填了自由文本（`{ selected: [], custom: '...' }`），`mapped.length === 0`，于是整个字段被省略，而不只是丢掉文本。把文本追加进数组会把非 option-id 塞进 id 空间；返回裸字符串会违反该字段的数组类型。省略是类型上最诚实的选择。

### 9.2 select 字段上的自由文本被丢弃；若因此留下必填项未答，交互被**取消**而非提交

`validateQuestionAnswers` 只接受 option id，所以 select 字段上的自由文本不可表示，只能丢弃（非必填时表现为一个诚实的「缺键」）。

必填字段因此未答时，`lib/index.js` 的 question 分支**主动返回 `{ status: 'cancelled' }`**，而不是提交一个缺字段的结果。原因是：提交缺必填项会让协议校验器在工厂的 `handle` 里抛错，而那是**能力失败（capability failure）**，不是一次干净的取消——两者的语义不同，后者才是这里想表达的。

### 9.3 `fromTuiAnswers` 返回 null-prototype 对象

字段 id 与选项标签来自其他组件，普通对象会解析继承成员（id 为 `toString` 会读到 `Object.prototype.toString`；标签为 `__proto__` 不会存成普通键）。所以 decoder 表与答案对象都用 `Object.create(null)`。

后果：`Object.hasOwn(answers, id)`、`JSON.stringify`、`Object.entries`、展开运算符都正常，但 `answers.hasOwnProperty(...)` 会**抛错**（该方法不在原型链上）。本仓库内部只使用 `Object.hasOwn`。

### 9.4 执行回执上的 `commandId` 来自原始行，别名不规范化

标准**没有定义 tokenizer**，所以 `commandNameOf` 只做两件事：去掉前导 `/`，截到第一个空白。

因此 `/exit` 产生 `commandId: "exit"`，而不是规范名 `quit`。消费方若用它做归属统计，需要自己知道 `/quit` 与 `/exit` 是同一个命令。

### 9.5 secret 提示的 `minLength` / `maxLength` 以 UTF-16 单元计量，掩码的点数按码点计

协议校验器比较的是 `result.secret.length`，即 **UTF-16 单元**；所以模态的边界检查也用 `state.draft.length`（同一把尺子），否则会出现「模态放行、校验器抛错」的能力失败。掩码的圆点数量则用 `Array.from(draft).length`，即**码点**数——那是用户感知的「字符数」。

两者对**星光平面字符（emoji 等）**会不一致，所以错误文案里的「characters」对这类输入是近似的。CJK 是 BMP，一个字符一个单元，从不分歧。

### 9.6 TUI 的 9 个命令出现两次

- `dsh-plugin.json` 的静态贡献：用于**发现与预检**（不执行代码就能被宿主和 CI 读取）；
- `lib/std/command-list.js` 的 `TUI_OWNED_COMMANDS`：**命令目录与执行归属判断**——`lib/index.js` 的 `commandCatalog`（列出命令）与 `executeCommand`（判断一行命令是否归 TUI 所有）读它。

注意：`runCommand` 的本地 switch **不读这个常量**，它用的是字面量分支（`settings` / `help` / `stats` / `new` / `resume` / `model` / `provider` / `clear` / `cancel` / `quit` / `exit` / `rewind`）。设计 §6.2 把两者描述为**两份独立的清单**，不要把它们合并成一份：静态贡献用于发现与预检，本地 switch 是实际执行路径，而 `TUI_OWNED_COMMANDS` 是目录与归属判断的数据源。

两份数据由测试钉在一起（从 `dsh-plugin.json` 投影出的命令名集合必须等于 `TUI_OWNED_COMMANDS`），所以它们不能漂移。本地 switch 的字面量分支与这份清单之间**没有**自动化断言——Task 10 的实现报告里做过一次手工交叉核对（每个自有命令都有对应的 case 分支），但那是人跑的一次性检查，不是测试。

现阶段不会有用户可见症状：adapter 把 `Command` 扩展映射进注册表后，只有当某个产品 UI 注册了匹配 placement 的 surface provider 才会把它 surface 回来。

### 9.7 提问模态上的 Esc 现在会**委托**（这是一次行为变更，也是一次修复）

重构前，`askQuestions` 的 defer 分支调用 `next()`，但 `next` 只被绑定为 `ctx.on('user-questions/request', (req, next) => ...)` 的形参，而 `askQuestions` 是 `apply()` 作用域里的同级声明——**`next` 是自由标识符**。按 Esc 会抛 `ReferenceError: next is not defined`，而且是在 `detach()` 已经执行、模态已经消失**之后**才抛，于是 promise 永不 settle，**工具调用永久挂起**。

现在 `next` 作为参数传入（`askQuestions(req, next)`，`onDefer: next` 是已解析的绑定），Esc 真正委托给 waterfall 的下一个应答者——这正是原注释一直声称的行为。

**这是本次接入里唯一一处用户可见的行为变化**，并且是修复而非回归。它没有自动化覆盖（模态路径需要真实 TTY 与 cordis 上下文），也**尚未在真实终端上验证**：这项冒烟属于实施计划的 Task 13，截至本文写作时**尚未执行**，也没有 task-13 报告。结果会记录在那里。

### 9.8 开放缺口（不是既定行为）

以下各项都不是既定行为，不应被当作已支持的能力：第一项是**上游阻断**，其余三项在设计的适配清单里、但**代码和文档都没有做**。列在这里是为了让它们可见，不是为了给它们一个「已知行为」的名分。

#### 9.8.1 本插件当前不发布任何协议 support（上游阻断，最重要的一项）

Community v0.15 清单无法声明 protocol supports，而 `@dsh-std/lifecycle` 只允许暂存已声明的 support；因此本插件的 facet 在当前上游上**一条协议都不暂存**，Phase B 处于休眠状态。**完整推理、守卫行为与实测结果见开头的[阻断性发现](#阻断性发现本插件当前不发布任何协议-support)**，此处不重复。

#### 9.8.2 授权提示丢弃了 `origin`、`details` 与 `risk`

标准路径只把 `request.action` 映射为 `toolName`、`request.summary` 映射为 `reason`（`lib/index.js` 的 `interact` 审批分支），`origin`、`details`、`risk` 三个字段**没有被读取，也没有被显示**。

**这可能是一条 MUST 违反**：协议文本（据评审引述）要求提供方清晰显示 `action`、`summary`、`origin`，以及策略允许的 `details`。**写本文时无法重新核对这段引文**——上游 clone 的 `docs/proposals/` 是空的，且当时没有网络。所以读者在决定「实现这些显示」还是「修改我们的声称」之前，**应先对着协议原文确认**这条要求的确切措辞与强度。

值得注意的是，`details` 可能正是用户做出知情决定所需要的信息；当前提示只画工具名与理由，用户看不到它。

#### 9.8.3 `deadline` 被忽略，`{ status: 'expired' }` 永远不会产生

请求里带 `deadline` 字段，但**没有任何代码读它**；中止（abort）一律映射为 `cancelled`。后果是消费方设置的截止时间不被遵守，模态会无限期等待，而协议里 `expired` 这个状态在本插件里不可达。

#### 9.8.4 `lib/bridge.js` 的两种加载顺序只测了一种

见 §4.1：已测的是「先创建 handler / 工厂，再注册句柄，再调用」；**「先注册句柄、再创建 handler / 工厂」没有测试**。前者足以抓住早绑定，所以这个缺口是覆盖完整性问题，不是已知缺陷。

---

## 10. 相关文件

| 文件 | 职责 |
| --- | --- |
| `dsh-plugin.json` | 静态清单。唯一被 adapter 与 CI 读取的声明面 |
| `lib/facet.js` | facet 入口，默认导出 `defineFacet(...)` 形状。只做协议注册与状态上报，**不启动 TUI** |
| `lib/bridge.js` | 活体 TUI 注册表。零依赖 |
| `lib/std/adapt.js` | 纯适配函数：std 类型 ↔ TUI 内部形状。无 IO、无副作用 |
| `lib/std/presentation.js` | Presentation 的 implementation 工厂接线（静态 import `@dsh-std/presentation`）。已写好并有测试；当前不被 facet 暂存（见开头阻断性发现） |
| `lib/std/commands.js` | CommandRuntime 的 handler 与工厂接线（静态 import `@dsh-std/command`）。已写好并有测试；当前不被 facet 暂存（见开头阻断性发现） |
| `lib/std/command-list.js` | 零依赖纯数据：placement 坐标、TUI 自有命令、命令描述 |
| `lib/index.js` | 在 `apply()` 内注册活体句柄；命令执行路径 |
| `tests/std.test.mjs` | 本接入的协议、适配与清单测试（不含渲染） |
| `tests/render.test.mjs` | secret 提示模态的渲染与「无残留」断言（其余渲染回归也在此） |
