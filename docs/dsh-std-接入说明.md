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
| `commands.dsh/v1alpha1` `Command` | **留给将来的消费方（`optional`，当前未消费）** | 清单把这条依赖保留给**将来的消费方**（见 §3.2），但**今天没有任何代码读它**：`lib/` 里没有任何 `protocols.client(...)` 调用。清单里这是 `requires.contracts` 唯一的一条，且标了 `optional: true`——没有 Command 提供方时 TUI 照常工作 |

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
| `name` / `version` / `license` | `dsh-oc-tui` / `0.1.4-pre.1` / `LGPL-3.0-or-later` | `version` 与 `license` 必须与 `package.json` 一致，测试会交叉校验 |
| `source.repository` | 仓库地址 | 仅元数据 |
| `facets` | 只有 `host` 一个键 | `facets` 是 `additionalProperties: false`，`entry` 与 `apiVersion` 必填；`apiVersion` 必须**精确等于** `v1alpha1`（adapter 是精确匹配，不是 semver） |
| `requires.contracts` | 一条 `commands.dsh/v1alpha1 Command`，`optional: true` | 见 §3.2 |
| `permissions` | `storage.local.read` / `storage.local.write`，`scope` 为本组件 id | 权限声明。TUI 的设置读写走宿主的 `ctx.settings`（持久化到 `$DSH_HOME/settings.yaml`），**不是** std 的 Storage 协议——本插件不接入 Storage（见 §7） |
| `contributes` | `x-dev.dsh-std.extensions` 下的 9 条 Command | 见 §3.3 |
| `overrides` | 一条 `{ target: "@deepseek-ai/dsh-base", kind: "patch" }` | `target` 是**被 patch 的宿主层**，不是本插件的仓库地址：`cordis.patch.yml` 的四行是在 `@deepseek-ai/dsh-base` 之上追加的 |

投影结果（`projectManifest`）：facet 的激活坐标是 `lifecycle.dsh/v1alpha1` / `FacetModule`，`spec.module` 为 `lib/facet.js`；`requires.contracts` 变成该 facet 的 `spec.protocols.requires`，`optional` 原样保留（`tests/std.test.mjs` 在**原始 JSON**（`:95-97`）与**投影**（`:109-111`）上都断言了这一点）。

### 3.2 为什么 `requires.contracts` 只有 `Command`，而且标了 `optional`

这一条声明的不是「当前正在消费」，而是**留给将来消费方的入口**：它今天完全惰性——`lib/` 里没有任何代码读 `commands.dsh/v1alpha1 Command`，也没有任何行为依赖它。

**但当前它不读别人贡献的命令。** `lib/` 里没有任何 `protocols.client({ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' })` 调用：TUI 的命令解析走 cordis 的 `ctx.commands` 服务（harness 自己的注册表），`lib/std/commands.js` 发布的 `CommandRuntime` 是**提供**方向（别人来驱动 TUI），不是消费方向。设计 §6.2 也说明，std 的 `Command` 扩展只有在某个产品 UI 注册了 `DshCommandSurfaceProvider` 时才会被 surface 回来，而本插件没有注册。

因此这一条必须带 `"optional": true`。lifecycle 对**非 optional** 且无人提供的 requirement 是**硬激活失败**（`facet … requirements are unavailable`），不是警告——而 TUI 没有任何 Command 提供方也能正常工作，「必需」就是虚假声明。标成 optional 后语义才诚实：**有** Command 提供方时 TUI 的行为与**没有**时完全相同——两者都不读贡献的命令；`optional` 保证的只是「没有提供方时不硬失败」，而不是「有提供方时会消费」。

**为什么清单里没有 Presentation 的条目：** Presentation 是 TUI **提供**的（ContributionHost **不在其中**：本插件不注册贡献宿主，`@dsh-std/ui` 也没有可供 facet 使用的实现工厂，见 §7.2）。而 Community v0.15 的清单**没有 `supports` 字段**——静态清单只能声明 `requires`，不能声明 support。support 只能运行时通过 `context.protocols.implement(...)` 产生，**而运行时这条路当前也是关的**：`implement()` 只接受 facet 投影里已声明的 support，清单既不能声明，投影里自然没有（见开头的阻断性发现）。把提供的协议写进 `requires.contracts` 会变成**虚假声明**：那是在说「我需要别人提供它」，与事实相反。

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

**§9.8 是例外**：那里列的是开放缺口——一项上游阻断、两项已修复并关闭的历史缺口（保留编号以便追溯），以及三项尚未完成的设计项——不是既定行为，不应被当作已支持的能力。

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

**这是本次接入里唯一一处用户可见的行为变化**，并且是修复而非回归。它现在有自动化覆盖：`tests/esc-questions.test.mjs` 用真实 cordis 上下文与真实 TTY 按键路径驱动这条分支（见文末[验证记录](#验证记录)）。

### 9.8 开放缺口（不是既定行为）

以下各项都不是既定行为，不应被当作已支持的能力：9.8.1 是**上游阻断**；9.8.2 与 9.8.3 已在收尾工作中**修复并关闭**（保留编号以便追溯，正文如实记录修法）；9.8.4、9.8.5 与 9.8.6 仍是**代码（或测试）没有做**的部分。列在这里是为了让它们可见，不是为了给它们一个「已知行为」的名分。

#### 9.8.1 本插件当前不发布任何协议 support（上游阻断，最重要的一项）

Community v0.15 清单无法声明 protocol supports，而 `@dsh-std/lifecycle` 只允许暂存已声明的 support；因此本插件的 facet 在当前上游上**一条协议都不暂存**，Phase B 处于休眠状态。**完整推理、守卫行为与实测结果见开头的[阻断性发现](#阻断性发现本插件当前不发布任何协议-support)**，此处不重复。

#### 9.8.2 授权提示丢弃了 `origin`、`details` 与 `risk`（**已修复**）

**修复前：** 标准路径只把 `request.action` 映射为 `toolName`、`request.summary` 映射为 `reason`（`lib/index.js` 的 `interact` 审批分支），而审批提示只画 `Approval · <toolName> · y allow / n deny`——`summary` 存而不画，`origin`、`details`、`risk` 三个字段根本没有被读取。协议正文要求「Provider 必须清楚显示 action、summary、origin 和经 policy 允许的 details」，因此这是对 MUST 的违反。

**这条引用已重新核对（2026-09-20）。** `dsh-std` 的 `docs/proposals/presentation.zh.md:359` 原文即上述句子，MUST **确认成立**——早先「上游 clone 不完整、网络不可达、无法复核」的保留说法已作废，此处不再留 hedge。审批提示现在按该条显示 `action`、`summary`、`origin`、`risk` 与 `details`；`details` 中标记 `sensitivity: 'private'` 的项显示其 label、值以掩码代替（见下）。

**修复后：** `lib/index.js` 的 `awaitApproval` 状态携带 `toolName`（action）、`summary`、`origin`、`details`、`risk`；标准路径逐一映射，harness 路径（`askApproval`）只有 `req.toolName` 与 `req.reason`，后者按同义映射到 `summary`，`origin` / `details` / `risk` 保持 `undefined`——不编造值。`lib/ui.js` 新增 `_approvalLines(width, maxRows)`，把 action、summary、origin、risk、每个 detail 的 `label: value` 渲染成 composer 内容行；`risk` 按 `low`/`medium`/`high` 取 `success`/`warning`/`error` 色调，与其它行视觉上可区分。composer 的高度由同一个 helper 计算（`_layout` 与绘制共用），所以内容与边框不会各说各话；内容超出行数时保留 action 与按键提示，中间部分截断并显示 `… N more`。

**`sensitivity: 'private'` 的 detail：显示 label，值以固定宽度的 `••••••` 代替。** 这是**无 policy 层下的保守默认，不是协议规定**。依据是 `presentation.zh.md:185` 对 `CopyText.sensitivity` 的语义——「`private` 提醒 Provider 采用不写日志、不显示全文的处理，但不是额外 permission grant」——该句是**为 `CopyText` 写的**，协议并没有把它规定到 `ApprovalDetail.sensitivity` 上；我们**把同一原则扩展**到了审批 detail，因为协议本身把「哪些 details 可以显示」交给 policy，而本插件没有 policy 层，所以选择隐藏而不是显示。标记用固定宽度而非按值长度生成，避免泄漏被隐藏值的长度。渲染测试断言该值**不出现在任何单元格里**（`tests/render.test.mjs`）。

#### 9.8.3 `deadline` 被忽略，`{ status: 'expired' }` 永远不会产生（**已修复，已关闭**）

**修复前：** 请求里带 `deadline` 字段，但**没有任何代码读它**；中止（abort）一律映射为 `cancelled`。后果是消费方设置的截止时间不被遵守，模态会无限期等待，而协议里 `expired` 这个状态在本插件里不可达。

**修复后：** `lib/index.js` 的三个模态等待（`awaitApproval`、`waitForQuestions`、`waitForSecret`）都接受 `deadline`，用 `deadlineDelay(deadline)`（`lib/std/adapt.js`，纯函数）算出剩余毫秒并起一个 `setTimeout`；**每一条 settle 路径都经过 `detach()`，而定时器正是在 `detach()` 里被 `clearTimeout`**，所以一个已被用户回答的模态不会留下活着的定时器（这一点有测试直接读 `process.getActiveResourcesInfo()` 验证）。到期时等待以**独立的结果**结束，而不是 `cancelled`：审批用 TUI 自己的词汇 `'expired'`（`approvalOutcome('expired')` → `{ status: 'expired' }`），提问与 secret 用内部 `EXPIRED` Symbol 哨兵（不可能与答案、密钥值或 defer 的返回值混淆），句柄把它映射为 `{ status: 'expired' }`。

**已过去的 `deadline` 立即到期，而不是起一个负延时定时器**：`deadlineDelay` 对过去的时间返回 `0`，等待函数在**安装模态之前**就以过期结果返回，所以提示既不会闪现一帧，也不会走到 `setTimeout(fn, 0)`。无法解析的 `deadline` 按「没有 deadline」处理——协议自己的校验器会拒绝非 RFC 3339 的值，因此这种形状到不了合规的提供方，而对一个人仍要回答的提示来说，等待比凭空立即过期破坏性更小。

harness 路径（`approval/request` waterfall、`user-questions/request` waterfall）没有 deadline，因此不传、也不起定时器。

**测试：** 纯的一半（`deadlineDelay` 的算术、过去/现在/未来/不可解析）在 `tests/std.test.mjs`；闭包内的一半（真的起定时器、真的关闭模态、真的映射为 `expired`、定时器真的被清掉）在 `tests/deadline.test.mjs`——它挂载**真实的** `apply()` 与真实 cordis 上下文，并通过真实活体句柄驱动三种请求。该文件的断言经过反向验证：把 `detach()` 里的 `clearTimeout` 去掉，定时器泄漏断言立刻失败（`before=3 after=4`）；把 `approvalOutcome('expired')` 改回 `cancelled`，两条过期断言立刻失败。

**本项已关闭。** 到期以独立的 `expired` 结束，与 `cancelled`（消费方中止）严格区分，二者都不是决定；协议里原本不可达的 `expired` 现在可达。§9.8.3 不再属于开放缺口。

#### 9.8.4 通知的 `deduplicationKey` 被忽略，重复通知不会合并

标准 `NotificationRequest` 带一个可选的 `deduplicationKey`，声明为 `readonly deduplicationKey?: string`（`node_modules/@dsh-std/presentation/lib/index.d.ts:57`），校验器只要求它是**非空字符串**（`node_modules/@dsh-std/presentation/lib/index.js:174`）。已发布产物里没有对这个字段作用的散文定义，但从字段名与设计自己的表述可以确定它的意图：它是消费方给通知贴的去重标识——携带同一个键的通知是**同一条**通知，提供方应把它们合并显示，而不是逐条投递。设计 §6.1 的适配清单把它列为需要新增的工作：「`deduplicationKey` 需要新增去重」（`docs/superpowers/specs/2026-09-19-dsh-std-interop-design.md:385`）。

`lib/index.js` 的 `notify` 只读 `request.text` 与 `request.level`，`deduplicationKey` **没有被读取，也没有任何去重逻辑**：每次调用都直接 `app.showToast(...)`（`lib/index.js:2984`），而 `showToast`（`lib/ui.js:1055`）只是把 `this.toast` 换成最新的一条，不保存键，也不看时间窗。

后果：消费方要求合并为一条的两条通知会被**分别投递**，去重完全不发生。注意 toast 是单槽位、后来的覆盖先前的，所以紧挨着的两条相同通知在屏幕上看起来仍是一条；但去重并没有发生——若两条之间夹了别的 toast，重复的那条会再次出现。**这一项尚未实现**，而且它不是一次字段映射就能补齐的：实现去重需要给 `showToast` 增加「键 + 时间窗」的状态，是新行为，不是适配。

与 9.8.2 / 9.8.3 一样，这处在 Phase B 的休眠路径上（见开头的[阻断性发现](#阻断性发现本插件当前不发布任何协议-support)），所以它不是今天用户可见的缺陷；但与前两项不同，**它还没有被修**：它是上游放开 support 声明之后**必须补上**的工作，记在这里是为了不让它再一次无声地漏掉。

#### 9.8.5 `lib/bridge.js` 的两种加载顺序只测了一种

见 §4.1：已测的是「先创建 handler / 工厂，再注册句柄，再调用」；**「先注册句柄、再创建 handler / 工厂」没有测试**。前者足以抓住早绑定，所以这个缺口是覆盖完整性问题，不是已知缺陷。

#### 9.8.6 命令目录返回的 descriptor 是残缺的，只有 `name` 与 `description`

协议 `CommandDescriptor` 要求**七个**成员：`name`、`description`、`owner`、`resource`、`available`、`missingPresentation`、`issues`（`node_modules/@dsh-std/command/lib/index.d.ts:56-70`；另有可选的 `input`）。而本插件的活体句柄只产出两个：

```js
return TUI_OWNED_COMMANDS.map((name) => ({
  name,
  description: COMMAND_DESCRIPTIONS[name] ?? '',
}))
```

（`lib/index.js:2999-3007`；`lib/std/commands.js:54-60` 的 handler 把它原样包进 `CommandCatalog`，不补字段。）

**没有任何东西会拦住它。** `commandRuntimeImplementation` 的 `handle` 只校验**输入**（`validateCatalogInput` / `validateExecutionInput`），**从不校验输出**（`node_modules/@dsh-std/command/lib/index.js:73-78`）。所以缺字段不会在提供方一侧抛错，故障被推迟到消费方：

- `descriptor.owner` 是 `undefined`，因此 `descriptor.owner.component` **抛 `TypeError`**（不是读到 `undefined`）；
- `descriptor.resource` 与 `descriptor.available` 都是 `undefined`；
- 遍历 `descriptor.missingPresentation` 或 `descriptor.issues` 同样会**抛 `TypeError`**（`for...of undefined`），因为它们是 `undefined` 而不是 `[]`。

**这一项尚未实现**，而且不是一次字段映射就能补齐的：`owner` / `resource` 的取值本身就没有决定。设计 §6.2 只说 `catalog(...)` 返回 `CommandDescriptor[]`（`docs/superpowers/specs/2026-09-19-dsh-std-interop-design.md:402-403`），**从未决定 TUI 自有命令的 `owner` 与 `resource` 该填什么**；实施计划反而把形状写窄成 `[{name, description}]`（`docs/superpowers/plans/2026-09-19-dsh-std-interop.md:2092`）。一个计划层面的取舍与协议自己的类型冲突时，那是**缺口，不是决定**——这正是它被记在这里、而不是被当作已支持能力的原因。

**范围说明：Phase B 目前是休眠的**（Community v0.15 清单无法声明 protocol supports，`lib/facet.js` 因此什么都不暂存——见开头的[阻断性发现](#阻断性发现本插件当前不发布任何协议-support)），所以**今天没有任何消费方能碰到它**。这是 shim 上线之前**必须补上**的工作，不是当前在发生的缺陷。因为 `owner` / `resource` 的形态未定，本文不臆测一个「正确」的 descriptor 应该长什么样。

### 9.9 控制字符不会进入输出流（**已修复的安全项**）

**修复前：** `Screen.set` 原样存储字符，`term.paint` 把每个 cell 的字符逐个写进输出流。因此一段带 `\x1b[2J\x1b[H` 的文本——一个工具名、一条路径、一个标题、一段 markdown——会被终端当作控制序列执行（清屏、移光标，甚至写剪贴板）。这既是既存问题（harness 自有的 `approval/request` 也画 `req.toolName`），也是标准路径**新增**的来源：另一个组件通过协议送来的 `action` 会直接落到这条路径上，而协议正文（`docs/proposals/presentation.zh.md:359`）的**第二句**正是这条要求——原文「Consumer 不能把 shell escape、ANSI control sequence 或 HTML 注入解释为可信 UI markup。」（该引用已重新核对，确认成立。）**这是本次收尾里唯一一处真正的、新的攻击面**：修复前，一个组件只需发 `action: "x\x1b[2J\x1b[H"`，本 TUI 就会替它输出清屏序列。

**修复后：** 在**咽喉点** `Screen.set`（`lib/term.js`）把 C0（`\u0000-\u001f`）、DEL（`\u007f`）与 C1（`\u0080-\u009f`）替换为可见的 `\uFFFD`；宽字符续接用的空串标记原样通过。选 `set` 而不是逐个调用点，是因为调用点大量绘制不受信内容（`chars[i]`、`title`、`path`、`branch`、`cwd`、`command`、`description`、`line.slice(...)`、`match[0]`……），一处修复覆盖整棵渲染树。用可见占位符而非丢弃：丢弃会改变宽度与布局，占位符让注入**看得见**。

**测试：** `tests/smoke.test.mjs` 断言 cell 缓冲里控制字符被替换、C1/DEL/BEL 同样被替换、宽字符续接标记不受影响，以及**绘制后输出流里不含来自文本的 ESC**（既没有 `\x1b[2J`，也没有 `\x1b[Hcleared`，且 `\uFFFD` 可见）。`npm test` 全绿，说明 composer 的分行渲染（换行是行分隔符，不是被绘制的字符）未受影响。

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
| `tests/render.test.mjs` | secret 与 approval 提示模态的渲染与「无残留」断言（其余渲染回归也在此） |
| `tests/esc-questions.test.mjs` | 真实 cordis 上下文 + 真实 TTY 按键路径下的提问模态 Esc 行为（Task 13 第 6 项） |
| `tests/deadline.test.mjs` | 真实 cordis 上下文 + 真实活体句柄下的 `deadline` 行为：过期、过期≠取消、定时器不泄漏 |
| `tests/secret-prompt.test.mjs` | 真实 cordis 上下文 + 真实活体句柄 + 原始字节下的 secret 提示：粘贴落到掩码草稿而非 composer、多行折叠、`minLength`/`maxLength`（UTF-16 计量）、退格删整个码点 |

---

## 验证记录

**日期：** 2026-09-20 ｜ **分支：** `feat/dsh-std-interop` 已合并入 `main`（PR #4，合并提交 `8a9c2ce`）｜ **验证时加载的构建：** `0.1.4-pre.1`

实施计划 Task 13 是「真实 TUI 冒烟」关卡，共 10 项。本节如实区分**已执行**与**未验证/无法执行**，未执行的不写成已执行。

### 第一次冒烟作废：它跑的不是本分支的构建

真人第一次冒烟的反馈只有一句：**「一样的，没有什么变化。」**

这句话本身没有错，但它描述的不是本分支的构建。核对 `~/.dsh/profiles/tui` 实际加载的产物：

- profile 里 `node_modules/dsh-oc-tui` 是指向 `.pnpm/dsh-oc-tui@file+…+dsh-oc-tui-0.1.3.tgz__reqh5…` 的符号链接，该 tgz 的时间戳是 **2026-09-11**；
- 那个构建里**没有** `lib/facet.js`、**没有** `lib/bridge.js`、**没有** `lib/std/`——这三样是本分支新增的；
- 它的 `lib/ui.js` 里 `_approvalLines` 出现 **0 次**，审批提示仍是改动前的单行 `Approval · <toolName> · y allow / n deny`；
- 仓库根目录的 `dsh-oc-tui-0.1.3.tgz` 是同一个 09-11 的产物（同样没有 `lib/std/`，同样没有 `_approvalLines`），也就是计划里早已注明的「既有产物，未重新打包」。

也就是说，`dsh --profile tui` 起来的是**本分支之前的代码**。所以「没有什么变化」是那个构建的预期表现，它**不能**当作本分支第 1–5 项的证据。它能说明的只有一件事：改动前那份代码在真实终端里仍然正常——而那不是本关卡的验收条件。**这一条记录保留，是因为它是第二次冒烟的前提：版本号必须 bump 到 `0.1.4-pre.1`、重新打包、装进 profile，才能让真实终端验证到本分支。**

### 已执行（真人，真实终端）：第 1–5 项、第 6 项、第 3 步

**结论：全部与预期一致，无回归。这是本次改动风险最高的一处（模态抽取）所需要的真实终端证据。**

环境：dsh `0.1.5-rc.1`、Node v24.18.0、`--profile tui`、加载的构建为 `0.1.4-pre.1`（安装后已核对 `lib/facet.js`、`lib/bridge.js`、`lib/std/` 与 `_approvalLines` 俱在）。真人的回报是：**「和你说的回报内容一致」**，即下列各项均如预期。

| 项 | 期望 | 结果 |
| --- | --- | --- |
| 第 1 项 | TUI 正常启动，标题栏与 composer 正常渲染，发消息能打开会话 | **通过** |
| 第 2 项 | 普通消息流式回复；审批模态 `y` 允许 / `n` 拒绝 / `Esc` 取消均能正常继续 | **通过** |
| 第 3 项 | `/help`、`/stats`、`/settings` 与改动前一致 | **通过** |
| 第 4 项 | `Ctrl+P` Settings 正常打开，凭据项仍以掩码显示 | **通过** |
| 第 5 项 | `Esc Esc` / `/rewind` 正常 | **通过** |
| 第 6 项 | 触发 `ask_user_question` 后按 Esc：模态关闭、工具调用正常结束（**期望与改动前不同**，改动前会挂死） | **通过** |
| 第 3 步 | 复制走 OSC 52，未因复制拉起新的 `powershell.exe` | **通过** |

**关于第 2 项的外观变化，如实说明：** 审批框从原来的一行 `Approval · <工具名> · y allow / n deny` 变成了多行字段框（第一行动作 + 提示，第二行 `Summary · <理由>`）。这一项通过，意味着新框在真实终端里渲染正常、`y`/`n`/`Esc` 三种应答都走得通；真人回报未把该外观变化列为问题。但「视觉上是否可以接受」是一次主观判断，本记录只记载「未被报告为问题」，不把它夸大成一次明确的视觉验收。

**这一节与自动化测试的分工：** 上面七项是真人证据；第 6 项同时有 `tests/esc-questions.test.mjs` 的自动化覆盖（见下一节），两者独立。第 7/8/9/10 项既没有真人执行、也无法执行，见「无法执行」一节。

### 已执行（自动化）：第 6 项 —— 提问模态上的 Esc（唯一的行为变更）

**结论：与改动前的预期一致，验证通过。**

验证方式不是人工敲键，而是 `tests/esc-questions.test.mjs`：它把**真实的** `lib/index.js` 的 `apply()` 挂进**真实的** cordis `Context`，注册**真实的** `@deepseek-ai/dsh-user-questions` 的 `UserQuestionService`（也就是 `ask_user_question` 工具实际调用的那个服务），再通过 `lib/term.js` 自己的按键解码器向无头 TTY 喂入**原始 ESC 字节**。因此 `ctx.waterfall`、`next` 续延、`decodeKey`、`handleQuestionKey`、模态渲染都是真的——只有终端本身是模拟的。

三个场景，18 条断言全绿：

| 场景 | 结果 |
| --- | --- |
| 提问模态打开 → Esc，且 waterfall 上没有其他应答者 | promise **settle**（不再挂死），以服务自己的 `NO_PROVIDER` 拒绝；模态关闭 |
| 提问模态打开 → Esc，waterfall 下游有另一个应答者 | Esc **真的委派**：下游应答者的答案就是工具调用收到的结果 |
| 提问模态打开 → Enter 正常作答 | 回归护栏：答案与所选选项原样送达 |

**这个测试确实能抓到那个 bug**（不是空过）：把 `lib/index.js` 临时改回重构前的形态（`askQuestions(req)` + `onDefer: () => next()` 中的自由标识符 `next`），该测试立刻失败，报的正是计划里记录的那一条：

```
ReferenceError: next is not defined
    at onDefer (lib/index.js:1242)
    at Object.defer (lib/index.js:1159)
    at handleQuestionKey (lib/index.js:1403)
```

这正是 §9.7 描述的「`settled` 已置位、模态已 `detach()`，但 promise 永不 settle」的成因。改动已还原，`git diff` 为空。

**边界说明：** 这条验证覆盖的是「Esc 之后的行为」与「按键→模态→委派」的完整链路。它**没有**覆盖真实终端仿真器本身（备用屏、raw mode、OSC 52、鼠标跟踪）在真实 Windows Terminal / iTerm 下的表现，也没有覆盖真实模型发起 `ask_user_question` 工具调用的整条 agent 循环——这两项需要一个真人坐在真实终端前。就本项要回答的问题（Esc 是委派还是挂死）而言，结论是确定的。

### 已执行：第 7、8、9 项 —— secret 提示的三条闭包路径

**结论：三条路径现在都有自动化覆盖，断言全部经过反向验证。**

原先这三项被记为「只能靠 Task 13 的真人冒烟」，理由是它们都在 `apply()` 的闭包内、位于真实 TTY 之后。这个理由**已不成立**：`tests/secret-prompt.test.mjs` 沿用 `tests/deadline.test.mjs` 的做法，把**真实的** `apply()` 挂进**真实的** cordis `Context`（`DSH_HOME` 指向一次性目录），注册真实 harness 服务，通过真实活体句柄（`registerLiveTui`）发出 `secret-input` 请求，并用 `lib/term.js` 自己的解码器喂入**原始字节**（含 `ESC[200~ … ESC[201~` 的 bracketed paste 与 OSC 52 应答）。`app` 是闭包内的 const，测试从它自己的一次 `render()` 上取到该实例来读草稿与 composer——只观察，不改变绘制。

覆盖与反向验证：

| 项 | 断言要点 | 反向验证（故意破坏后立刻失败） |
| --- | --- | --- |
| 第 8 项（粘贴路径） | 粘贴进入掩码草稿、`app.inputText` 为空、帧上是 bullets 且**无明文**、提示关闭后 composer 仍为空 | 去掉 `key.name === 'paste'` 拦截 → 9 条失败，`inputText = "sk-live-abc123"` 且关闭后仍在 |
| 第 8 项（多行折叠） | 含 `\n`/`\r\n` 的粘贴被折叠为单行，换行不留在草稿里 | 去掉 `.replace(/[\r\n]+/g, '')` → 2 条失败，草稿为 `"line1\nline2\r\nline3"` |
| 第 7 项（长度约束） | 低于 `minLength` → 模态不关且显示错误；高于 `maxLength` → 同样；区间内 → `submitted` 且值原样 | 关掉 min 分支 → 3 条失败（`"ab"` 被提交）；把 min 阈值调严 → 区间内提交断言失败（`expired`） |
| 第 9 项（UTF-16 计量） | 两个 emoji（2 码点 / 4 UTF-16 单元）在 `maxLength: 2` 下被拒 | 把 `state.draft.length` 换成 `Array.from(...).length` → 3 条失败，模态直接提交了 `"🔑🔑"`（正是校验器会拒绝的值） |
| 退格删码点 | `"ab🔑"` + Backspace → `"ab"`，且草稿无孤立代理项 | 换成 `slice(0, -1)` → 3 条失败，草稿为 `"ab\ud83d"`（孤立高代理） |

**未能反向区分的一处（如实记录）：** 剪贴板分支里清 `clipboardRequested` 的那一行无法被单独区分。把 `key.name === 'clipboard'` 拦截整段去掉，测试仍然全绿——因为粘贴拦截还在，而只有一条空粘贴才会置上 `clipboardRequested`，空粘贴被粘贴拦截吃掉后 `handleClipboard` 自己的早返回就够了。只有当**两个**拦截同时去掉时，OSC 52 应答才会以明文 `"clipboard-secret"` 落进 composer，此时断言失败。也就是说：这一条测的是「空粘贴 + 剪贴板应答」的合并路径，不是剪贴板拦截本身。

### 无法执行与未执行（Task 13 的其余各项）

**其余各项的状态如下。区分「无法执行」（结构上触发不到）与「未执行」（做得到但没做）——两者都不是已验证：**

- **第 7、8、9、10 项（secret 提示与窄终端钳制）——无法执行**，不是未验证。secret 面板只由标准协议的 `secret-input` 请求打开（`waitForSecret` 的唯一调用者在 `lib/index.js:3032` 的 `request.kind === 'secret-input'` 分支里，该 handler 又只由 facet 暂存，而 facet 当前什么都不暂存），所以正常会话里打不开这个面板：第 7 项的长度约束、第 8 项的粘贴拦截、第 9 项的 UTF-16 边界、第 10 项的 21 列钳制，全都无从触发。它们的保障来自测试，不是来自这次冒烟：长度约束/粘贴/UTF-16/退格删码点由 `tests/secret-prompt.test.mjs` 用真实 cordis 上下文与原始字节覆盖，钳制分支由 `tests/render.test.mjs` 的 `[26, 20]` 覆盖。
- **第 1 步与第 4 步**（打包、装进本地 profile、再卸载）——**第 1 步已完成，第 4 步未执行**。版本号已 bump 到 `0.1.4-pre.1`，已重新打包，并已装进 `--profile tui`（`dsh plugin --profile tui list` 显示 `dsh-oc-tui 0.1.4-pre.1`）。安装后的副本已逐项核对：`lib/facet.js`、`lib/bridge.js`、`lib/std/` 五个文件与 `dsh-plugin.json` 都在包内，`lib/ui.js` 的 `_approvalLines` 出现 3 次，两个清单的版本都是 `0.1.4-pre.1`。`remove -w` / `add -w` 完整往返也已实测成功，装回去的副本仍是分支构建。仓库里原来那个 09-11 的 `dsh-oc-tui-0.1.3.tgz` 已删除；`*.tgz` 本就在 `.gitignore` 里、从未进过仓库。

  安装过程中有一个值得记下的坑：`dsh plugin --profile tui add` 不加 `-w` 会被 pnpm 的 `ERR_PNPM_ADDING_TO_ROOT` 挡住（profile 目录下有 `pnpm-workspace.yaml`，它把自己声明为工作区根）。**正确做法就是 README「Why `-w`」一节写的加 `-w`**。另一个坑：删掉旧 tgz 会让 pnpm 在安装时报 `ENOENT … dsh-oc-tui-0.1.3.tgz`，因为 profile 的 `package.json` 仍指向它——必须先移除或重指该依赖再装（README 的 Troubleshooting 已记载此条）。
- **标准路径独占的三行显示**（审批模态的 Origin / Risk / Details）——**无法在现有形态下验证**，原因有两层且互相独立：其一，这三个字段只可能来自标准协议的 `ApprovalRequest`，而本插件自身的审批来自 harness 的 `approval/request`，其载荷只有 `toolName` 与 `reason`（`lib/index.js:1120` 只映射这两个字段，origin/details/risk 保持 `undefined`），`lib/ui.js:1813` 起也只画实际存在的字段；其二，B 阶段休眠，没有任何标准请求能到达。所以即便装的是分支构建，正常跑一次也看不到这三行——它们需要一个真正的标准请求方，而这是阶段 B 休眠的直接后果，不是缺陷。

**仍然只能靠真人的部分**（与本次新增覆盖无关）：真实终端仿真器本身的行为（备用屏、raw mode、OSC 52 剪贴板、鼠标跟踪在真实 Windows Terminal / iTerm 下的表现）、真实模型发起工具调用的整条 agent 循环。本次新增的是**模态内部逻辑**的覆盖：它用真实 cordis 上下文、真实句柄与真实字节驱动，因此能抓住手搓 context 抓不到的契约（例如 waterfall 的 `next` 续延）；它与真人冒烟互补，不互相替代。

因此本节的覆盖状态是：**第 1–5 项、第 6 项、第 3 步有真人真实终端证据**（构建 `0.1.4-pre.1`，回报与预期一致）；**第 7/8/9/10 项与标准路径独占的三行显示无法执行**，其保障来自 `tests/secret-prompt.test.mjs`、`tests/render.test.mjs` 与结构上的不可达；**第 4 步（卸载往返）未执行**。`npm test` 全绿（870 条断言）只覆盖它自己触及的代码路径，不构成对上述无法执行项的替代。
