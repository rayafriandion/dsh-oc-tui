# dsh-std 互操作接入实施计划（阶段 A + B）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh-oc-tui 成为 `@dsh-std` 生态里一个可被静态预检、可被其他标准组件驱动的 TUI：先落静态清单与 facet 外壳（阶段 A），再把已有的模态 / 通知 / 剪贴板 / 命令行发布成标准协议（阶段 B）。

**Architecture:** TUI 的生命周期**仍然**由 `cordis.patch.yml` 的 bundle 行拥有。`lib/facet.js` 只做互操作外壳：通过 `lib/bridge.js` 这个晚绑定的活体 TUI 注册表，把标准协议的 handler 转发到当前运行的 TUI 实例；没有活体实例时 `snapshot()` 报 `degraded`、handler 返回 `unavailable`。这样规避了 `@dsh-std/adapter-dsh` 无条件挂载 `dsh-plugin.json` 导致的**双激活**（它会为同一个组件再跑一遍 `apply()`，而 TUI 抢占终端，两份会互抢 raw mode / 备用屏）。

**Tech Stack:** ESM JavaScript（无构建步骤）、Node `^22.19 || >=24`、Cordis 插件、`@dsh-std/sdk` + `@dsh-std/presentation` + `@dsh-std/command` + `@dsh-std/ui`（peer，optional）、手写测试 harness（无测试框架）。

**设计依据：** `docs/superpowers/specs/2026-09-19-dsh-std-interop-design.md`

## Global Constraints

以下取自 spec，每个 task 都隐含遵守：

- **Node engines 收紧为 `^22.19 || >=24`**（与 `@dsh-std/*` 一致，spec §5.4）。
- **`@dsh-std/*` 依赖必须 pin 精确版本，禁止 `^` 或裸包名**（npm `latest` tag 落后于 git main，spec §3.1）。固定值：
  - `@dsh-std/sdk` `0.1.1-rc.2`
  - `@dsh-std/presentation` `0.1.1-rc.1`
  - `@dsh-std/command` `0.1.1-rc.1`
  - `@dsh-std/ui` `0.1.1-rc.1`
  - `@dsh-std/manifest` `0.1.1-rc.3`（仅 devDependency，测试用）
- **清单 `id` 固定为 `io.github.rayafriandion.dsh-oc-tui`**；facet 激活坐标固定为 `lifecycle.dsh/v1alpha1` / `FacetModule`；`facets.host.apiVersion` 必须精确等于 `v1alpha1`（adapter 是精确匹配，不是 semver）。
- **产品自有坐标使用 `tui.dsh/v1alpha1` / `CommandLine`**（生态治理规定 TUI 生态用 `tui.dsh/*`）。
- **facet 绝不启动 TUI、绝不调用 `lib/index.js` 的 `apply()`**（spec §4.1）。这是硬约束。
- **不改 TUI 现有的问答选择语义**：`draft.selected` 存的是 option 的 **label**（`lib/index.js:1212-1217`），这是与 WebUI composer 兼容的编码（`lib/index.js:1097` 注释），标准协议的 id 映射必须放在适配层，不能改这里。
- **`CopyText` 带 `sensitivity: 'private'` 时禁止走 PowerShell 回退**：该回退把文本 base64 作为命令行参数传给 `powershell.exe`（`lib/term.js:416`），同用户其他进程可读。
- **不实现、不声明** `OpenExternal`、`ExternalRedirect`、`local-module` 贡献模式、`session.dsh`、Storage、Tool、Model、Skill。
- **测试沿用现有 harness**：`tests/smoke.test.mjs` 的 `eq(name, actual, expected)` / `ok(name, cond)`，`console.log("ok ...")` / `FAIL`，JSON.stringify 比较，失败时 `process.exit(1)`。不引入测试框架。
- **每个新文件开头的用途注释、`// ---- name ----` 分隔线、扁平 `lib/` 布局**，与现有文件一致。
- **提交信息用 `feat(tui):` / `test(tui):` / `docs(tui):` / `chore(pkg):` 前缀**，与现有 git log 一致。

## 文件结构

| 文件 | 职责 |
|---|---|
| `dsh-plugin.json`（新建，包根） | 静态清单。唯一被 adapter 与 CI 读取的声明面。 |
| `lib/bridge.js`（新建） | 活体 TUI 注册表。唯一的"TUI 实例在哪"的真相来源。零依赖。 |
| `lib/facet.js`（新建） | facet 入口。默认导出 `defineFacet(...)`。只做协议注册与状态上报，不启动 TUI。 |
| `lib/std/adapt.js`（新建） | 纯函数适配层：std 类型 ↔ TUI 内部形状。无 IO、无副作用，最容易测。 |
| `lib/std/presentation.js`（新建） | Presentation 的 implementation 工厂，把 std handler 接到 `liveTui()`。 |
| `lib/std/commands.js`（新建） | CommandRuntime 的 handler（catalog / execute）。 |
| `lib/std/contribution-host.js`（新建） | `UiContributionProvider` 实现 + 贡献登记。 |
| `lib/index.js`（修改） | 抽出可复用的模态等待函数；在 `apply()` 内 `registerLiveTui(...)`；用 `ctx.effect` 释放。 |
| `lib/term.js`（修改） | `copyToClipboard(text, options)` 增加 `osc52Only`。 |
| `lib/ui.js`（修改） | 贡献面在 Settings 的渲染；secret-input 模态的绘制。 |
| `package.json`（修改） | files / engines / peerDeps / devDeps / scripts。 |
| `tests/std.test.mjs`（新建） | 本计划的全部测试。加入 `npm test`。 |
| `README.md`、`docs/dsh-std-接入说明.md`（新建/修改） | 文档。 |

**为什么 `lib/std/` 与 `lib/bridge.js` 分开：** `bridge.js` 是 TUI 自己的运行时契约（`lib/index.js` 与 `lib/facet.js` 都依赖它），而 `lib/std/` 是协议适配层，只在 facet 被加载时才需要。把 `bridge.js` 放在协议目录里会让 `lib/index.js` 为了一个 `@dsh-std` 无关的注册表去 import 协议目录，依赖方向就错了。

---

## Task 1: `lib/bridge.js` — 活体 TUI 注册表

**Files:**
- Create: `lib/bridge.js`
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: 无（零依赖）
- Produces:
  - `registerLiveTui(handle: object): () => void` — 注册当前活体 TUI 句柄，返回**幂等**的释放函数
  - `liveTui(): object | null` — 返回当前句柄或 `null`

- [ ] **Step 1: 写失败的测试**

创建 `tests/std.test.mjs`：

```js
// Tests for the @dsh-std interop layer: the live-TUI registry, the pure
// adapters between standard and TUI shapes, and the protocol shims.
// Run: node tests/std.test.mjs  (no dsh environment required)
import { registerLiveTui, liveTui } from "../lib/bridge.js"

let failed = 0
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { console.log("ok   " + name) }
  else { console.log("FAIL " + name + "  got " + a + "  want " + e); failed++ }
}
const ok = (name, cond) => cond ? console.log("ok   " + name) : (console.log("FAIL " + name), failed++)
// For assertions that a call does not throw: a bare call would abort the whole
// file on failure, so the throw becomes a counted FAIL and the run keeps
// reporting the remaining assertions.
const noThrow = (name, fn) => {
  try { fn(); console.log("ok   " + name) }
  catch (error) { console.log("FAIL " + name + "  threw " + error.message); failed++ }
}

// ---- bridge ----
eq("no live TUI initially", liveTui(), null)

{
  const h = { tag: "first" }
  const release = registerLiveTui(h)
  eq("liveTui returns the registered handle", liveTui(), h)
  release()
  eq("release clears the handle", liveTui(), null)
  release()
  eq("release is idempotent", liveTui(), null)
}

// The two assertions above cannot distinguish a guard-free release from a
// guarded one: a second release on an already-empty registry trivially yields
// null. This case is what actually pins the `released` flag — re-registering
// the same handle and then calling the spent release must not clear the new
// registration.
{
  const h = { tag: "re-registered" }
  const spent = registerLiveTui(h)
  spent()
  const release2 = registerLiveTui(h)
  spent()
  eq("a spent release does not clear a re-registration", liveTui(), h)
  release2()
  eq("the re-registration can still be released", liveTui(), null)
}

{
  const a = { tag: "a" }
  const b = { tag: "b" }
  const releaseA = registerLiveTui(a)
  const releaseB = registerLiveTui(b)
  releaseA()
  eq("stale release must not clear a newer registration", liveTui(), b)
  // Leave the registry empty: later sections of this file assert on the
  // no-live-TUI state, and a handle left registered here would break them.
  releaseB()
  eq("the registry is empty again for the sections that follow", liveTui(), null)
}

console.log("")
if (failed > 0) { console.log(failed + " test(s) failed"); process.exit(1) }
console.log("all std tests passed")
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/bridge.js'`

- [ ] **Step 3: 实现**

创建 `lib/bridge.js`：

```js
// The live-TUI registry: the one place that answers "is a TUI instance running,
// and how do I reach it".
//
// The @dsh-std facet (lib/facet.js) does not own the TUI's lifecycle — the
// cordis bundle rows in cordis.patch.yml do. The facet only publishes protocol
// implementations whose handlers forward here. Because the adapter's mount
// order relative to the bundle rows is not guaranteed, handlers must look the
// handle up at call time (late binding) rather than capture it at activation.
//
// No dependencies: lib/index.js imports this, so it must stay free of anything
// that could fail to resolve in a lean profile.

let active = null

// Register the running TUI. Returns an idempotent release function that only
// clears the registry if this registration is still the current one — a newer
// registration must survive an older one's teardown.
export function registerLiveTui(handle) {
  active = handle
  let released = false
  return () => {
    if (released) return
    released = true
    if (active === handle) active = null
  }
}

// The current TUI handle, or null when no TUI is running. Callers must handle
// null: it is the normal state when the facet is mounted in a profile whose
// bundle rows did not load.
export function liveTui() {
  return active
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/std.test.mjs`
Expected: 全部 `ok`，最后一行 `all std tests passed`

- [ ] **Step 5: 提交**

```bash
git add lib/bridge.js tests/std.test.mjs
git commit -m "feat(tui): add the live-TUI registry the std facet forwards through"
```

---

## Task 2: `dsh-plugin.json` 静态清单

**Files:**
- Create: `dsh-plugin.json`
- Modify: `package.json`（增加 `@dsh-std/manifest` devDependency，并把新测试接进 `test` script）
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: 包根 `dsh-plugin.json`，其 `facets.host.entry` 指向 `lib/facet.js`（Task 3 创建）、`id` 为 `io.github.rayafriandion.dsh-oc-tui`

- [ ] **Step 1: 装测试所需的依赖**

Run:
```bash
npm install --save-dev --save-exact @dsh-std/manifest@0.1.1-rc.3
```
Expected: `package.json` 的 `devDependencies` 出现 `"@dsh-std/manifest": "0.1.1-rc.3"`

- [ ] **Step 2: 写失败的测试**

在 `tests/std.test.mjs` 的 import 区加入：

```js
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { parseManifest, projectManifest } from "@dsh-std/manifest"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..")
```

在 `console.log("")` 之前加入：

```js
// ---- manifest ----
{
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  const raw = readFileSync(join(repoRoot, "dsh-plugin.json"), "utf8")
  const manifest = parseManifest(raw, { source: "dsh-plugin.json" })

  eq("manifest id", manifest.id, "io.github.rayafriandion.dsh-oc-tui")
  eq("manifest version tracks package.json", manifest.version, pkg.version)
  eq("manifest license tracks package.json", manifest.license, pkg.license)
  eq("facet entry", manifest.facets.host.entry, "lib/facet.js")
  eq("facet apiVersion", manifest.facets.host.apiVersion, "v1alpha1")

  // The TUI consumes Command resources (it reads other components' commands).
  // Presentation and ContributionHost are things the TUI *provides*, and
  // Community v0.15 has no `supports` field, so they must NOT appear here.
  eq("requires.contracts is exactly the Command resource",
    manifest.requires.contracts,
    [{ apiVersion: "commands.dsh/v1alpha1", kind: "Command" }])

  const projected = projectManifest(manifest)
  const facet = projected.spec.facets[0]
  eq("projects to one host facet", projected.spec.facets.length, 1)
  eq("activation coordinate", facet.activation.apiVersion, "lifecycle.dsh/v1alpha1")
  eq("activation kind", facet.activation.kind, "FacetModule")
  eq("activation module", facet.activation.spec.module, "lib/facet.js")

  // Commands must carry placements, which the simple contributes.commands route
  // drops (its projection keeps only { title }). Without placements a command is
  // publishable on every surface, so a web UI would list /settings too.
  const commands = facet.extensions.filter((e) => e.kind === "Command")
  eq("nine TUI-owned commands contributed", commands.length, 9)
  ok("every command is scoped to the TUI command line",
    commands.every((e) => JSON.stringify(e.spec.placements)
      === JSON.stringify([{ apiVersion: "tui.dsh/v1alpha1", kind: "CommandLine" }])))
  ok("every command carries a contribution id label",
    commands.every((e) => typeof e.metadata.labels["dsh.std/contribution-id"] === "string"))

  const names = commands.map((e) => e.metadata.name).sort()
  eq("contributed command names", names,
    ["cancel", "clear", "help", "new", "quit", "resume", "rewind", "settings", "stats"])
  // /model and /provider are deliberately absent: runCommand asks
  // ctx.commands.find() first, so the harness owns them when it registers them.
  ok("model and provider are not claimed", !names.includes("model") && !names.includes("provider"))

  const quit = commands.find((e) => e.metadata.name === "quit")
  eq("quit keeps the exit alias", quit.spec.aliases, ["exit"])

  const perms = facet.permissions.map((p) => p.action + " @ " + p.spec.scope).sort()
  eq("storage permissions are scoped to the component id", perms, [
    "storage.local.read @ io.github.rayafriandion.dsh-oc-tui",
    "storage.local.write @ io.github.rayafriandion.dsh-oc-tui",
  ])

  // The bundle patch is a real host patch and must be declared as one.
  eq("overrides records the cordis bundle patch",
    manifest.overrides.map((o) => o.target + ":" + o.kind),
    ["@deepseek-ai/dsh-base:patch"])
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory, open '.../dsh-plugin.json'`

- [ ] **Step 4: 创建清单**

创建 `dsh-plugin.json`（内容与 spec §5.1 一致，已实测通过 `parseManifest` + `projectManifest`）：

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
    { "name": "storage.local.read", "scope": "io.github.rayafriandion.dsh-oc-tui",
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

`overrides[].target` 是**被 patch 的宿主层**，不是本插件的仓库地址：`cordis.patch.yml` 插入的四行是在 `@deepseek-ai/dsh-base` 之上追加的。

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/std.test.mjs`
Expected: 全部 `ok`，最后一行 `all std tests passed`

- [ ] **Step 6: 提交**

**不要提交 `package-lock.json`。** 本仓库从来没有 lockfile：它不存在、未被 git 跟踪、也没有被 `.gitignore` 忽略——它的缺席是这个仓库一贯的选择，不是为了本 task 才改变的。`npm install` 会在本地生成一个，装完后删掉它，让工作区保持干净：

```bash
rm -f package-lock.json
git add dsh-plugin.json package.json tests/std.test.mjs
git commit -m "feat(tui): declare the dsh-std component manifest"
```

（`files` 白名单意味着 lockfile 也不会进 npm 包；这里要避免的是给贡献者引入一套他们没选的依赖管理方式。）

---

## Task 3: `lib/facet.js` + package.json 收尾

**Files:**
- Create: `lib/facet.js`
- Modify: `package.json`（`files`、`engines`、`peerDependencies`、`peerDependenciesMeta`、`devDependencies`、`scripts.check`、`scripts.test`）
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: `registerLiveTui` / `liveTui`（Task 1）；`dsh-plugin.json` 的 `facets.host.entry`（Task 2）
- Produces: `lib/facet.js` 默认导出满足 `assertFacetModule`（`activate` 是函数）的 `FacetModule`；`snapshot()` 返回 `{state:'active'|'degraded'}`

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 import 区加入：

```js
import { pathToFileURL } from "node:url"
```

在 `console.log("")` 之前加入：

```js
// ---- facet ----
{
  // The adapter takes `namespace.default ?? namespace.facet` and requires
  // `activate` to be a function; without @dsh-std/sdk installed the module must
  // still load and report degraded rather than throw, because a throw during
  // mountProfileComponents rolls back every other component in the profile.
  const mod = await import(pathToFileURL(join(repoRoot, "lib/facet.js")).href)
  const facet = mod.default
  ok("facet default export exists", facet !== undefined && facet !== null)
  eq("facet exports exactly activate/deactivate/snapshot",
    Object.keys(facet).sort(), ["activate", "deactivate", "snapshot"])
  eq("facet.activate is a function", typeof facet.activate, "function")
  eq("facet.deactivate is a function", typeof facet.deactivate, "function")
  eq("facet.snapshot is a function", typeof facet.snapshot, "function")

  const degraded = await facet.snapshot()
  eq("facet reports degraded with no live TUI", degraded.state, "degraded")
  ok("facet explains why it is degraded",
    typeof degraded.message === "string" && degraded.message.length > 0)

  const release = registerLiveTui({ tag: "facet-test" })
  eq("facet reports active with a live TUI", (await facet.snapshot()).state, "active")
  release()
  eq("facet returns to degraded after the TUI unloads", (await facet.snapshot()).state, "degraded")
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `ENOENT ... lib/facet.js`

- [ ] **Step 3: 实现 `lib/facet.js`**

```js
// The @dsh-std facet entry declared by dsh-plugin.json.
//
// HARD CONSTRAINT: this module must never start the TUI. The TUI's lifecycle
// belongs to the cordis bundle rows in cordis.patch.yml; the adapter mounts
// this facet in ADDITION to those rows, and the TUI seizes the terminal
// (raw mode, alt screen, mouse tracking), so a second instance would fight the
// first rather than merely duplicate it.
//
// The facet is therefore an interop surface: it publishes protocol
// implementations whose handlers forward through lib/bridge.js to whichever TUI
// instance is live, and reports `degraded` when none is.
//
// @dsh-std/sdk is loaded dynamically and defensively. A throw from this module
// makes the adapter's mountProfileComponents roll back EVERY component it had
// already mounted in the profile, so a missing peer dependency here must
// degrade, never throw.

const DEGRADED_MESSAGE =
  'dsh-oc-tui is activated by its cordis bundle rows (cordis.patch.yml); '
  + 'no live TUI instance is registered, so no protocol support is published.'

export default {
  async activate(context) {
    const { liveTui } = await import('./bridge.js')
    let sdk
    try {
      sdk = await import('@dsh-std/sdk')
    } catch {
      // Peer dependency absent: nothing to publish. snapshot() already reports
      // the state, so activation stays a no-op rather than an error.
      return
    }
    const dispose = await activateProtocols(sdk, context, liveTui)
    context.scope.add(dispose)
  },

  async deactivate() {
    // Everything is registered through context.scope, which the lifecycle
    // coordinator disposes on deactivation. Nothing to do here.
  },

  async snapshot() {
    const { liveTui } = await import('./bridge.js')
    if (!liveTui()) return { state: 'degraded', message: DEGRADED_MESSAGE }
    return { state: 'active' }
  },
}

// Wired up in Task 8 / Task 10 / Task 14, one protocol per task.
async function activateProtocols() {
  return () => {}
}
```

- [ ] **Step 4: 更新 `package.json`**

四处修改：

1. `files` 加入清单（否则 npm 包里没有它，adapter 永远找不到）：
```json
  "files": [
    "lib",
    "bin",
    "cordis.patch.yml",
    "dsh-plugin.json",
    "docs/用户手册.md"
  ],
```

2. `engines` 收紧（与 `@dsh-std/*` 一致）：
```json
  "engines": {
    "node": "^22.19 || >=24"
  },
```

3. `peerDependencies` 与 `peerDependenciesMeta` 加入四个协议包，**精确版本、不带 `^`**，且全部 optional（facet 必须在它们缺席时降级）：
```json
    "@dsh-std/command": "0.1.1-rc.1",
    "@dsh-std/presentation": "0.1.1-rc.1",
    "@dsh-std/sdk": "0.1.1-rc.2",
    "@dsh-std/ui": "0.1.1-rc.1",
```
```json
    "@dsh-std/command": { "optional": true },
    "@dsh-std/presentation": { "optional": true },
    "@dsh-std/sdk": { "optional": true },
    "@dsh-std/ui": { "optional": true },
```

4. `devDependencies` 加入**同样这四个协议包**，同样精确版本：

```json
    "@dsh-std/command": "0.1.1-rc.1",
    "@dsh-std/presentation": "0.1.1-rc.1",
    "@dsh-std/sdk": "0.1.1-rc.2",
    "@dsh-std/ui": "0.1.1-rc.1",
```

**为什么 peer 和 dev 都要有。** `peerDependenciesMeta` 里标了 `optional: true` 的 peer，npm **不会**安装——这正是我们要的运行时行为（facet 必须在它们缺席时降级为 `degraded`，而不是让 adapter 的 `mountProfileComponents` 整体回滚）。但 Task 8 / 10 / 12 的测试会真的调用 `facet.activate(context)` 并断言注册了哪些协议，那就必须能真正 `import('@dsh-std/sdk')` 等模块。只声明 optional peer 而不声明 devDependency，那些测试必然失败。两边用同一批精确版本，避免测试对着与运行时不同的版本通过。

（Task 3 自己的测试不需要它们：它只调 `snapshot()`，不调 `activate()`，而 `lib/facet.js` 顶层没有静态 import。）

5. `scripts` 接入新测试与新文件检查：
```json
    "test": "node tests/smoke.test.mjs && node tests/render.test.mjs && node tests/rewind.test.mjs && node tests/std.test.mjs",
    "check": "node --check lib/index.js && node --check lib/ui.js && node --check lib/term.js && node --check lib/metrics.js && node --check lib/interrupt.js && node --check lib/web-settings.js && node --check lib/updates.js && node --check lib/rewind.js && node --check lib/bridge.js && node --check lib/facet.js && node --check bin/dsh-oc-tui.js"
```

- [ ] **Step 5: 运行测试与检查**

Run: `npm run check && node tests/std.test.mjs`
Expected: `check` 无输出（`node --check` 静默通过）；std 测试全部 `ok`

Run: `npm test`
Expected: 四个测试文件全绿，最后 `all std tests passed`

- [ ] **Step 6: 提交**

```bash
git add lib/facet.js package.json tests/std.test.mjs
git commit -m "feat(tui): add the std facet shell that reports TUI liveness"
```

---

## Task 4: `lib/std/adapt.js` — 纯适配函数

**Files:**
- Create: `lib/std/adapt.js`
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `notificationLevel(stdLevel) -> 'info' | 'warn' | 'error'`
  - `approvalOutcome(tuiOutcome) -> {status:'submitted', value:{decision}} | {status:'cancelled'}`
  - `toTuiQuestions(fields) -> { questions, decoders }`
  - `fromTuiAnswers(decoders, tuiAnswer) -> { answers }`

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 import 区加入：

```js
import { notificationLevel, approvalOutcome, toTuiQuestions, fromTuiAnswers } from "../lib/std/adapt.js"
```

在 `console.log("")` 之前加入：

```js
// ---- adapt: notification level ----
// The standard says 'warning'; the TUI's toast/system levels say 'warn'.
eq("notification info", notificationLevel("info"), "info")
eq("notification warning maps to warn", notificationLevel("warning"), "warn")
eq("notification error", notificationLevel("error"), "error")
eq("notification undefined defaults to info", notificationLevel(undefined), "info")

// ---- adapt: approval ----
// Only the TUI -> standard direction exists: the modal already settles in the
// TUI's own vocabulary ('allowed-once' | 'rejected' | 'cancelled'), and nothing
// in this design drives the modal from a standard decision.
eq("submitted approval", approvalOutcome("allowed-once"),
  { status: "submitted", value: { decision: "approved" } })
eq("submitted denial", approvalOutcome("rejected"),
  { status: "submitted", value: { decision: "denied" } })
// A cancel must never be readable as consent. This is the highest-consequence
// property in the module, so every non-decision shape is pinned, not just the
// named one.
eq("cancelled is not an approval", approvalOutcome("cancelled"), { status: "cancelled" })
eq("an unknown outcome is not an approval either",
  approvalOutcome("something-else"), { status: "cancelled" })
eq("undefined is not an approval", approvalOutcome(undefined), { status: "cancelled" })
eq("null is not an approval", approvalOutcome(null), { status: "cancelled" })
eq("a truthy non-decision is not an approval", approvalOutcome(true), { status: "cancelled" })

// ---- adapt: select field ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "target", label: "Which target?", kind: "select",
      options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
  ])
  eq("select becomes one question", questions.length, 1)
  eq("question id", questions[0].id, "target")
  eq("question text is the field label", questions[0].question, "Which target?")
  eq("question offers the option labels", questions[0].options.map((o) => o.label), ["Alpha", "Beta"])
  eq("select is single by default", questions[0].multiSelect, false)
  // The TUI keys selection by label (lib/index.js:1212-1217); the decoder maps
  // back to the standard's option id.
  eq("answer decodes back to the option id",
    fromTuiAnswers(decoders, { answers: [{ id: "target", selected: ["Beta"] }] }),
    { answers: { target: "b" } })
}

// ---- adapt: multiple select ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "tags", label: "Tags", kind: "select", multiple: true,
      options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
  ])
  eq("multiple select sets multiSelect", questions[0].multiSelect, true)
  eq("multiple answers decode to an array",
    fromTuiAnswers(decoders, { answers: [{ id: "tags", selected: ["X", "Y"] }] }),
    { answers: { tags: ["x", "y"] } })
}

// ---- adapt: multi-select keeps its array even with a custom answer ----
// The TUI keeps `selected` populated for a multi-select when a custom answer is
// also present (lib/index.js:1097-1103), and the standard's answer type has no
// slot for "selection plus free text". The array is the representable half, so
// the decoder must not fall through to the custom-text branch here.
{
  const { decoders } = toTuiQuestions([
    { id: "tags", label: "Tags", kind: "select", multiple: true,
      options: [{ id: "x", label: "X" }] },
  ])
  eq("a multi-select with a custom answer still answers with an array",
    fromTuiAnswers(decoders, { answers: [{ id: "tags", selected: ["X"], custom: "and more" }] }),
    { answers: { tags: ["x"] } })
}

// ---- adapt: duplicate labels must not collide ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "pick", label: "Pick", kind: "select",
      options: [{ id: "one", label: "Same" }, { id: "two", label: "Same" }] },
  ])
  eq("duplicate labels are disambiguated for display",
    questions[0].options.map((o) => o.label), ["Same", "Same (2)"])
  eq("the second duplicate decodes to its own id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["Same (2)"] }] }),
    { answers: { pick: "two" } })
}

// A literal label may already equal a generated suffix. Counting occurrences of
// the base label is not enough: it would emit "Same (2)" twice and let the last
// option overwrite the second one's id, so picking the second option would
// silently return the third option's id.
{
  const { questions, decoders } = toTuiQuestions([
    { id: "pick", label: "Pick", kind: "select",
      options: [{ id: "one", label: "Same" }, { id: "two", label: "Same" }, { id: "three", label: "Same (2)" }] },
  ])
  eq("a suffix-shaped literal label does not collide",
    questions[0].options.map((o) => o.label), ["Same", "Same (2)", "Same (3)"])
  eq("the second option keeps its own id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["Same (2)"] }] }),
    { answers: { pick: "two" } })
  eq("the third option keeps its own id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["Same (3)"] }] }),
    { answers: { pick: "three" } })
}

// Disambiguation is per field: a collision in one field must not shift the
// labels of another.
{
  const { questions } = toTuiQuestions([
    { id: "a", label: "A", kind: "select", options: [{ id: "a1", label: "Dup" }, { id: "a2", label: "Dup" }] },
    { id: "b", label: "B", kind: "select", options: [{ id: "b1", label: "Dup" }] },
  ])
  eq("the first field disambiguates", questions[0].options.map((o) => o.label), ["Dup", "Dup (2)"])
  eq("the second field is unaffected", questions[1].options.map((o) => o.label), ["Dup"])
}

// ---- adapt: ids and labels come from another component, so they must not be
// able to reach Object.prototype ----
{
  const { decoders } = toTuiQuestions([
    { id: "pick", label: "Pick", kind: "select",
      options: [{ id: "real", label: "__proto__" }] },
  ])
  eq("a __proto__ label round-trips to its id",
    fromTuiAnswers(decoders, { answers: [{ id: "pick", selected: ["__proto__"] }] }),
    { answers: { pick: "real" } })

  const plain = toTuiQuestions([{ id: "x", label: "X", kind: "text" }])
  // An answer for a field we never issued must be ignored, not crash and not
  // fabricate: `decoders.toString` must be undefined, not Object.prototype's.
  eq("an inherited-looking field id is ignored",
    fromTuiAnswers(plain.decoders, { answers: [{ id: "toString", selected: ["A"], custom: "x" }] }),
    { answers: {} })
  eq("an inherited-looking id with a selection does not throw",
    fromTuiAnswers(plain.decoders, { answers: [{ id: "valueOf", selected: ["A"] }] }),
    { answers: {} })
}

// ---- adapt: malformed answers must not throw ----
{
  const { decoders } = toTuiQuestions([{ id: "a", label: "A", kind: "text" }])
  eq("a non-array answers value yields no answers",
    fromTuiAnswers(decoders, { answers: {} }), { answers: {} })
  eq("a missing answers value yields no answers",
    fromTuiAnswers(decoders, {}), { answers: {} })
  eq("a null answer yields no answers",
    fromTuiAnswers(decoders, null), { answers: {} })
}

// ---- adapt: confirm ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "ok", label: "Proceed?", kind: "confirm" },
  ])
  eq("confirm offers Yes/No", questions[0].options.map((o) => o.label), ["Yes", "No"])
  eq("confirm yes decodes to true",
    fromTuiAnswers(decoders, { answers: [{ id: "ok", selected: ["Yes"] }] }),
    { answers: { ok: true } })
  eq("confirm no decodes to false",
    fromTuiAnswers(decoders, { answers: [{ id: "ok", selected: ["No"] }] }),
    { answers: { ok: false } })
}

// ---- adapt: text ----
{
  const { questions, decoders } = toTuiQuestions([
    { id: "why", label: "Why?", kind: "text" },
  ])
  eq("text field has no options", questions[0].options, [])
  eq("text answers come from the custom draft",
    fromTuiAnswers(decoders, { answers: [{ id: "why", selected: [], custom: "because" }] }),
    { answers: { why: "because" } })
}

// ---- adapt: unanswered fields are omitted, not invented ----
{
  const { decoders } = toTuiQuestions([
    { id: "a", label: "A", kind: "select", options: [{ id: "a1", label: "A1" }] },
    { id: "b", label: "B", kind: "text" },
  ])
  eq("a skipped field is omitted from the record",
    fromTuiAnswers(decoders, { answers: [{ id: "a", selected: ["A1"] }, { id: "b", selected: [] }] }),
    { answers: { a: "a1" } })
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/std/adapt.js'`

- [ ] **Step 3: 实现**

创建 `lib/std/adapt.js`：

```js
// Pure adapters between @dsh-std shapes and the TUI's internal shapes.
//
// No IO, no side effects, no dependency on a running TUI — everything here is
// a plain function so it can be tested without a terminal.
//
// The important asymmetry: the standard keys question answers by option *id*,
// but the TUI keys selection by option *label* (lib/index.js:1212-1217). That
// encoding is shared with the WebUI composer and must not change, so the
// translation lives here instead.

// ---- presentation: notification ----------------------------------------

// The standard's levels are info/warning/error; the TUI's toast and system
// block levels are info/warn/error.
export function notificationLevel(level) {
  if (level === 'warning') return 'warn'
  if (level === 'error') return 'error'
  return 'info'
}

// ---- presentation: approval --------------------------------------------

// The TUI's approval modal settles with its own vocabulary; the standard's
// ApprovalValue is { decision: 'approved' | 'denied' }.
//
// A cancelled or aborted prompt is NOT a decision. Returning `cancelled`
// rather than a denial keeps the two distinguishable, so a consumer can never
// read a timeout as consent — and an unrecognised outcome is treated the same
// way, because guessing a decision is worse than reporting none.
export function approvalOutcome(tuiOutcome) {
  if (tuiOutcome === 'allowed-once') return { status: 'submitted', value: { decision: 'approved' } }
  if (tuiOutcome === 'rejected') return { status: 'submitted', value: { decision: 'denied' } }
  return { status: 'cancelled' }
}

// ---- presentation: questions -------------------------------------------

const CONFIRM_YES = 'Yes'
const CONFIRM_NO = 'No'

// Standard QuestionField[] -> TUI questions plus the decoders needed to turn
// the TUI's answer back into the standard's answers record.
//
// The TUI selects by label, and the standard does not promise unique labels,
// so duplicates get a display suffix. Without this, two options sharing a
// label would be indistinguishable on the way back and the answer would
// silently collapse onto the first.
export function toTuiQuestions(fields) {
  const questions = []
  // Null-prototype maps: field ids and option labels come from another
  // component, and a plain object would resolve inherited members — a field id
  // of `toString` would read Object.prototype.toString as a decoder, and an
  // option label of `__proto__` would not store a normal key.
  const decoders = Object.create(null)

  for (const field of fields ?? []) {
    const question = {
      id: String(field.id),
      question: String(field.label),
      header: field.label === undefined ? undefined : String(field.label),
      detail: field.description === undefined ? undefined : String(field.description),
      options: [],
      multiSelect: false,
    }

    if (field.kind === 'select') {
      const idByLabel = Object.create(null)
      // Allocate against the labels already used in THIS field rather than
      // counting occurrences of the base label. A literal label can already
      // equal a generated suffix — ["Same", "Same", "Same (2)"] is legal input
      // — and a collision would give two options the same display label and
      // overwrite each other's id mapping, so a selection would silently decode
      // to the wrong option.
      // When the base itself ends in " (n)", continue that counter from the
      // root, so the literal "Same (2)" collides into "Same (3)" rather than
      // the unhelpful "Same (2) (2)". A lone "Same (2)" keeps its label.
      const used = new Set()
      for (const option of field.options ?? []) {
        const base = String(option.label)
        const suffixed = /^(.*) \((\d+)\)$/.exec(base)
        const root = suffixed ? suffixed[1] : base
        let label = base
        let n = suffixed ? Number(suffixed[2]) : 1
        while (used.has(label)) {
          n += 1
          label = root + ' (' + n + ')'
        }
        used.add(label)
        idByLabel[label] = String(option.id)
        question.options.push({ label })
      }
      question.multiSelect = field.multiple === true
      // `multiple` must live on the decoder too: fromTuiAnswers uses it to
      // decide between a single string and an array, and the TUI keeps
      // `selected` populated for a multi-select even when a custom answer is
      // also present.
      decoders[question.id] = { kind: 'select', multiple: field.multiple === true, idByLabel }
    } else if (field.kind === 'confirm') {
      const idByLabel = Object.create(null)
      idByLabel[CONFIRM_YES] = true
      idByLabel[CONFIRM_NO] = false
      decoders[question.id] = { kind: 'confirm', idByLabel }
      question.options.push({ label: CONFIRM_YES }, { label: CONFIRM_NO })
    } else {
      // A text field has no options: the TUI answers it through the custom
      // draft, which the composer already supports.
      decoders[question.id] = { kind: 'text', idByLabel: Object.create(null) }
    }

    questions.push(question)
  }

  return { questions, decoders }
}

// TUI answer ({ answers: [{ id, selected: [label], custom? }] }) -> the
// standard's { answers: { [fieldId]: string | boolean | string[] } }.
//
// Fields the user left empty are omitted rather than guessed at: an absent key
// is honest, a fabricated default is not.
export function fromTuiAnswers(decoders, tuiAnswer) {
  // Null-prototype for the same reason as the decoder maps: an id of
  // `__proto__` must be an ordinary key, not a prototype write.
  const answers = Object.create(null)
  // `?? []` only covers null/undefined; a non-array would make for...of throw.
  const entries = Array.isArray(tuiAnswer?.answers) ? tuiAnswer.answers : []
  for (const entry of entries) {
    const decoder = decoders[entry?.id]
    if (!decoder) continue

    if (decoder.kind === 'text') {
      const text = String(entry.custom ?? '').trim()
      if (text !== '') answers[entry.id] = text
      continue
    }

    const selected = Array.isArray(entry.selected) ? entry.selected : []
    const mapped = selected.map((label) => decoder.idByLabel[label]).filter((v) => v !== undefined)

    if (decoder.kind === 'confirm') {
      if (mapped.length > 0) answers[entry.id] = mapped[0]
      continue
    }

    // A custom answer on a single-select question replaces the selection; the
    // TUI encodes that by clearing `selected`, so a non-empty custom is a
    // free-text answer the standard can carry as a plain string.
    const custom = String(entry.custom ?? '').trim()
    if (custom !== '' && !decoder.multiple) {
      answers[entry.id] = custom
      continue
    }
    if (decoder.multiple) {
      if (mapped.length > 0) answers[entry.id] = mapped
      continue
    }
    if (mapped.length > 0) answers[entry.id] = mapped[0]
  }
  return { answers }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/std.test.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add lib/std/adapt.js tests/std.test.mjs
git commit -m "feat(tui): adapt between std question shapes and the TUI's label-keyed selection"
```

---

## Task 5: `CopyText` 的 private 路径

**Files:**
- Modify: `lib/term.js:401`（`copyToClipboard`）
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `copyToClipboard(text, options?)`，`options.osc52Only === true` 时跳过 PowerShell 回退

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 import 区加入：

```js
import { Terminal } from "../lib/term.js"
```

在 `console.log("")` 之前加入：

```js
// ---- term: private clipboard ----
{
  const writes = []
  const spawned = []
  const term = new Terminal()
  term.write = (chunk) => { writes.push(chunk); return true }
  // The fallback branch needs win32 AND a TTY to be reachable at all.
  term.output = { isTTY: true }
  const fakeSpawn = (cmd, args) => { spawned.push([cmd, args]); return { on() {} } }

  // The spoof is restored unconditionally: the harness's eq/ok do not throw
  // today, but a section added below this one, or a future assertion that does
  // throw, would otherwise run under a faked platform.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  try {
    writes.length = 0
    term.copyToClipboard("hello", { spawn: fakeSpawn })
    ok("copy writes OSC 52", writes.join("").includes("]52;c;"))
    ok("OSC 52 payload carries base64",
      writes.join("").includes(Buffer.from("hello", "utf8").toString("base64")))
    eq("the default path does spawn on win32", spawned.length, 1)
    // The fallback passes the text's base64 as a powershell.exe argument, where
    // any process of the same user can read it back.
    ok("the fallback receives the text as base64 in argv",
      spawned[0][1].join(" ").includes(Buffer.from("hello", "utf8").toString("base64")))

    spawned.length = 0
    writes.length = 0
    const privateWritten = term.copyToClipboard("secret", { osc52Only: true, spawn: fakeSpawn })
    eq("osc52Only never spawns the PowerShell fallback", spawned.length, 0)
    ok("osc52Only still writes OSC 52", writes.join("").includes("]52;c;"))
    // The payload must be this text, not a stale or empty one: an
    // implementation that wrote nothing would still satisfy the check above.
    ok("osc52Only writes the actual text",
      writes.join("").includes(Buffer.from("secret", "utf8").toString("base64")))
    eq("osc52Only still reports success", privateWritten, true)

    // This call must NOT reach the real fallback: the platform is spoofed to
    // win32 and this term reports a TTY, so leaving isTTY set would launch
    // powershell.exe for real and overwrite the host clipboard. Clearing output
    // keeps full discriminating power, because the option destructure runs
    // before the fallback guard.
    term.output = {}
    noThrow("a null options value does not throw", () => term.copyToClipboard("x", null))
    eq("a null options value still returns a boolean",
      typeof term.copyToClipboard("x", null), "boolean")
  } finally {
    Object.defineProperty(process, "platform", originalPlatform)
  }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `osc52Only never spawns the PowerShell fallback`（当前实现忽略第二个参数，在 win32 + TTY 下仍会 spawn），以及 `the fallback receives the text as base64 in argv` 因为 `spawn` 不可注入而报错。

- [ ] **Step 3: 实现**

把 `lib/term.js:401` 的 `copyToClipboard` 换成（新增第二个参数 `options`，并把 `spawn` 变成可注入以便测试）：

```js
  // Write text to the system clipboard. Primary path: an OSC 52 write, which
  // Windows Terminal, iTerm2, and most modern terminals honor. On Windows a
  // PowerShell fallback covers hosts that drop OSC 52 — the fallback
  // round-trips the text through base64 so UTF-8 (CJK, emoji) survives, unlike
  // `clip.exe`, which re-decodes stdin with the console's ANSI/OEM code page
  // and mangles non-ASCII. Both paths write the same UTF-8 text, so whichever
  // lands last leaves the clipboard correct. Best-effort: never throws.
  //
  // `osc52Only` exists for text the caller marked private: the fallback passes
  // the base64 as a powershell.exe command-line argument, which any process of
  // the same user can read back. Private text must stay on the in-band path.
  copyToClipboard(text, options = {}) {
    if (typeof text !== 'string' || text.length === 0) return false
    // `?? {}` as well as the default: an explicit null would otherwise throw
    // on the destructure, outside every try/catch, breaking the never-throws
    // contract this function is relied on for.
    // `spawn` is injectable so tests can observe the fallback without
    // launching powershell.exe; production always uses the module import.
    const { osc52Only = false, spawn: injectedSpawn } = options ?? {}
    // `?? spawn`, not a destructure default: `{ spawn: null }` must fall back to
    // the real spawn rather than making spawnFn null.
    const spawnFn = injectedSpawn ?? spawn
    let written = false
    try {
      this.write('\x1b]52;c;' + Buffer.from(text, 'utf8').toString('base64') + '\x1b\\')
      written = true
    } catch { /* output unavailable */ }
    if (!osc52Only && process.platform === 'win32' && this.output?.isTTY) {
      try {
        const b64 = Buffer.from(text, 'utf8').toString('base64')
        // System.Windows.Forms.Clipboard needs an STA thread; powershell.exe
        // honors -STA. The base64 argument is ASCII-only, so it passes through
        // CreateProcess and -Command untouched (no shell re-quoting).
        const script =
          'Add-Type -AssemblyName System.Windows.Forms;' +
          '[System.Windows.Forms.Clipboard]::SetText([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\'' + b64 + '\')))'
        const child = spawnFn('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: 'ignore',
          windowsHide: true,
        })
        child.on('error', () => { /* no PowerShell available */ })
        written = true
      } catch { /* spawn failure — OSC 52 may still have succeeded */ }
    }
    return written
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/std.test.mjs && node tests/smoke.test.mjs`
Expected: 两个文件全绿（smoke 里已有 `Terminal` 的断言，必须不受影响）

- [ ] **Step 5: 提交**

```bash
git add lib/term.js tests/std.test.mjs
git commit -m "fix(tui): keep private clipboard text off the PowerShell argv fallback"
```

---

## Task 6: `lib/std/presentation.js` — 协议实现

**Files:**
- Create: `lib/std/presentation.js`
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: `liveTui()`（Task 1）；`notificationLevel` / `approvalOutcome` / `toTuiQuestions` / `fromTuiAnswers`（Task 4）
- Produces:
  - `createPresentationImplementations() -> [{ support, implementation }]` — 供 facet 注册
  - `presentationOperations() -> string[]` — 当前实际支持的 UserInteraction operations
  - 依赖活体句柄的成员：`handle.interact(request)`、`handle.notify(request)`、`handle.copyText(request)`

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 import 区加入：

```js
import { createPresentationImplementations, presentationOperations } from "../lib/std/presentation.js"
```

在 `console.log("")` 之前加入：

```js
// ---- presentation shim ----
{
  const impls = createPresentationImplementations()
  const byKind = Object.fromEntries(impls.map((i) => [i.support.kind, i]))
  eq("publishes UserInteraction, Notification and CopyText",
    Object.keys(byKind).sort(), ["CopyText", "Notification", "UserInteraction"])
  ok("every support is on presentation.dsh/v1alpha1",
    impls.every((i) => i.support.apiVersion === "presentation.dsh/v1alpha1"))
  // OpenExternal and ExternalRedirect are deliberately absent: the TUI cannot
  // open a browser, and a redirect needs a loopback HTTP server.
  ok("does not claim OpenExternal", byKind.OpenExternal === undefined)
  ok("does not claim ExternalRedirect", byKind.ExternalRedirect === undefined)

  eq("user interaction operations", byKind.UserInteraction.support.spec.operations,
    ["question", "approval"])
  eq("presentationOperations matches the published support",
    presentationOperations(), ["question", "approval"])

  // With no live TUI every call must report unavailable — never a decision.
  const unavailable = { status: "unavailable" }
  const approval = await byKind.UserInteraction.implementation.interact(
    { kind: "approval", action: "shell", summary: "rm -rf /" })
  ok("approval with no live TUI is unavailable, not approved",
    approval.status === "unavailable")
  ok("approval never fabricates a decision",
    approval.value === undefined)
  eq("question with no live TUI is unavailable",
    (await byKind.UserInteraction.implementation.interact(
      { kind: "question", fields: [{ id: "a", label: "A", kind: "text" }] })).status, "unavailable")
  eq("notification with no live TUI is unavailable",
    (await byKind.Notification.implementation.notify({ text: "hi" })).status, "unavailable")
  eq("copy with no live TUI is unavailable",
    (await byKind.CopyText.implementation.copyText({ text: "hi" })).status, "unavailable")
}

// ---- presentation shim with a live TUI (late binding) ----
{
  const calls = []
  const impls = createPresentationImplementations()
  const byKind = Object.fromEntries(impls.map((i) => [i.support.kind, i]))

  // Register AFTER the implementations were created: the handler must look the
  // handle up at call time, because the adapter's mount order relative to the
  // cordis bundle rows is not guaranteed.
  const release = registerLiveTui({
    async interact(request) {
      calls.push(["interact", request])
      if (request.kind === "approval") return { status: "submitted", value: { decision: "denied" } }
      return { status: "submitted", value: { answers: { a: "x" } } }
    },
    async notify(request) { calls.push(["notify", request]); return { status: "submitted", value: { accepted: true } } },
    async copyText(request) { calls.push(["copyText", request]); return { status: "submitted", value: { accepted: true } } },
  })

  eq("approval forwards to the live TUI",
    await byKind.UserInteraction.implementation.interact({ kind: "approval", action: "a", summary: "s" }),
    { status: "submitted", value: { decision: "denied" } })
  eq("question forwards to the live TUI",
    await byKind.UserInteraction.implementation.interact({ kind: "question", fields: [] }),
    { status: "submitted", value: { answers: { a: "x" } } })
  eq("notification forwards to the live TUI",
    await byKind.Notification.implementation.notify({ text: "hi" }),
    { status: "submitted", value: { accepted: true } })
  eq("copy forwards the sensitivity through",
    (await byKind.CopyText.implementation.copyText({ text: "s", sensitivity: "private" }), calls.at(-1)[1]),
    { text: "s", sensitivity: "private" })

  release()
  eq("falls back to unavailable once the TUI unloads",
    (await byKind.Notification.implementation.notify({ text: "hi" })).status, "unavailable")
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/std/presentation.js'`

- [ ] **Step 3: 实现**

创建 `lib/std/presentation.js`：

```js
// Presentation implementations for the TUI: the TUI is a *provider* of these
// operations, not a consumer. Consumers reach them through the connection layer
// and end up in the handlers below.
//
// Every handler resolves the live TUI at call time (late binding) and reports
// `unavailable` when there is none. That is the honest answer and the safe one:
// `unavailable` can never be mistaken for consent, which matters most for
// approvals.
//
// Support is declared for what actually exists. OpenExternal is not claimed
// (the TUI cannot open a browser, and spawning one is outside its remit), and
// ExternalRedirect is not claimed (it needs a loopback HTTP server plus a
// browser).

import { liveTui } from '../bridge.js'

export const PRESENTATION_API_VERSION = 'presentation.dsh/v1alpha1'

// The operations the TUI's modals genuinely implement. `secret-input` joins
// this list in Task 12, when its standalone prompt lands.
export function presentationOperations() {
  return ['question', 'approval']
}

const UNAVAILABLE = (reason) => ({ status: 'unavailable', reason })

async function withLiveTui(fn) {
  const handle = liveTui()
  if (!handle) return UNAVAILABLE('no live dsh-oc-tui instance')
  return fn(handle)
}

// Returns the { support, implementation } pairs the facet publishes. The shape
// matches ActivationContext.protocols.implement(support, implementation).
export function createPresentationImplementations() {
  const userInteraction = {
    async interact(request) {
      return withLiveTui((handle) => handle.interact(request))
    },
  }
  const notification = {
    async notify(request) {
      return withLiveTui((handle) => handle.notify(request))
    },
  }
  const copyText = {
    async copyText(request) {
      return withLiveTui((handle) => handle.copyText(request))
    },
  }

  return [
    {
      support: {
        apiVersion: PRESENTATION_API_VERSION,
        kind: 'UserInteraction',
        spec: { operations: presentationOperations() },
      },
      implementation: userInteraction,
    },
    {
      support: { apiVersion: PRESENTATION_API_VERSION, kind: 'Notification' },
      implementation: notification,
    },
    {
      support: { apiVersion: PRESENTATION_API_VERSION, kind: 'CopyText' },
      implementation: copyText,
    },
  ]
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/std.test.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add lib/std/presentation.js tests/std.test.mjs
git commit -m "feat(tui): publish Presentation support that forwards to the live TUI"
```

---

## Task 7: 在 `lib/index.js` 注册活体 TUI 句柄

**Files:**
- Modify: `lib/index.js`（抽出可复用的模态等待函数；在 `apply()` 内注册句柄）
- Test: `tests/smoke.test.mjs`（回归）、`tests/std.test.mjs`（新增契约测试）

**Interfaces:**
- Consumes: `registerLiveTui`（Task 1）；`notificationLevel` / `approvalOutcome` / `toTuiQuestions` / `fromTuiAnswers`（Task 4）
- Produces: 活体句柄，成员 `interact` / `notify` / `copyText`（Task 6 的 handler 调用它们）

**注意：** 这个 task 只动 `lib/index.js` 的接线，**不改变** `askApproval` / `askQuestions` 对既有调用方（DSH 的 `approval/request` 与 `user-questions/request` waterfall）的行为。两个既有路径必须继续返回完全相同的值。

- [ ] **Step 1: 抽出审批等待逻辑**

`askApproval`（`lib/index.js:1033`）现在把"建 state + 挂 abort + 等 settle"整段写在自己里面。把它抽成 `awaitApproval`，让既有调用方与新的 std 路径共用，避免两份模态等待逻辑漂移。

把 `askApproval` 的函数体替换为：

```js
  // Wait on the approval modal. Shared by the harness waterfall and the
  // @dsh-std Presentation handler so both go through one piece of modal logic.
  // Resolves with the TUI's own vocabulary: 'allowed-once' | 'rejected' | 'cancelled'.
  function awaitApproval({ toolName, reason, signal }) {
    return new Promise((resolve) => {
      let settled = false
      const settle = (outcome) => {
        if (settled) return
        settled = true
        if (signal) signal.removeEventListener('abort', onAbort)
        if (app.pendingApproval?.id === state.id) app.pendingApproval = null
        resolve(outcome)
      }
      const onAbort = () => settle('cancelled')
      const state = {
        id: Math.random().toString(36).slice(2, 8),
        toolName,
        reason,
        settle,
      }
      if (signal) {
        if (signal.aborted) {
          resolve('cancelled')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      app.pendingApproval = state
      paint()
    })
  }

  function askApproval(req) {
    return awaitApproval({ toolName: req.toolName, reason: req.reason, signal: req.signal })
  }
```

- [ ] **Step 2: 抽出问答等待逻辑**

`askQuestions`（`lib/index.js:1109`）把"归一化 + 建 state + 挂 abort + 等 settle"写在一起，其中 `defer` 会调用 waterfall 的 `next()`。抽出 `waitForQuestions(questions, { signal, onDefer })`，让 std 路径复用（std 没有 `next()`，`onDefer` 由调用方决定）。

把 `askQuestions` 替换为：

```js
  // Wait on the question modal for an already-normalized question list.
  // `onDefer` is what Esc means to the caller: the harness waterfall delegates
  // to the next answerer, while the @dsh-std path has no waterfall and treats
  // it as a cancel.
  function waitForQuestions(questions, { signal, onDefer }) {
    return new Promise((resolve, reject) => {
      if (questions.length === 0) {
        resolve({ answers: [] })
        return
      }
      let settled = false
      const state = {
        id: Math.random().toString(36).slice(2, 8),
        questions,
        index: 0,
        drafts: questions.map(() => ({ selected: [], custom: '', skipped: false })),
        cursor: 0,
        customMode: false,
        customCursor: 0,
        scroll: 0,
        error: null,
        // Answering: hand the structured answer back to the pending tool call.
        settle: (answer) => {
          if (settled) return
          settled = true
          detach()
          resolve(answer)
        },
        // Esc: decline to answer here. The caller decides what that means.
        defer: () => {
          if (settled) return
          settled = true
          detach()
          resolve(onDefer())
        },
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        detach()
        // Rejecting with a plain error lets the service report its own
        // ASK_ABORTED ("aborted before the user answered").
        reject(new Error('user-questions request aborted'))
      }
      const detach = () => {
        if (signal) signal.removeEventListener('abort', onAbort)
        if (app.pendingQuestions?.id === state.id) app.pendingQuestions = null
        paint()
      }
      if (signal) {
        if (signal.aborted) {
          reject(new Error('user-questions request aborted'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      app.pendingQuestions = state
      paint()
    })
  }

  function askQuestions(req) {
    const questions = (Array.isArray(req.questions) ? req.questions : []).map(normalizeQuestion)
    return waitForQuestions(questions, { signal: req.signal, onDefer: next })
  }
```

- [ ] **Step 3: 注册活体句柄**

在 `lib/index.js` 顶部的 import 区加入：

```js
import { registerLiveTui } from './bridge.js'
import { notificationLevel, approvalOutcome, toTuiQuestions, fromTuiAnswers } from './std/adapt.js'
```

在 `const startupCheckTimer = setTimeout(() => { void startupUpdateCheck() }, 2000)`（`lib/index.js:2723`）之后、`ctx.effect(...)` 之前，插入：

```js
  // ---- @dsh-std interop surface -------------------------------------------
  // The facet (lib/facet.js) forwards standard protocol calls here. This is the
  // only place the TUI advertises itself; the facet owns no lifecycle of its
  // own, which is what keeps the adapter from activating the TUI twice.

  const releaseLiveTui = registerLiveTui({
    async interact(request) {
      if (request.kind === 'approval') {
        const outcome = await awaitApproval({
          toolName: request.action,
          reason: request.summary,
          signal: request.signal,
        })
        return approvalOutcome(outcome)
      }
      if (request.kind === 'question') {
        const { questions, decoders } = toTuiQuestions(request.fields)
        try {
          const answer = await waitForQuestions(questions, {
            signal: request.signal,
            onDefer: () => null,
          })
          if (answer === null) return { status: 'cancelled' }
          return { status: 'submitted', value: fromTuiAnswers(decoders, answer) }
        } catch {
          // The modal rejects on abort; the standard distinguishes that from a
          // human decision.
          return { status: 'cancelled' }
        }
      }
      return { status: 'unavailable', reason: 'unsupported interaction kind: ' + String(request.kind) }
    },

    async notify(request) {
      app.showToast(String(request.text), notificationLevel(request.level))
      paint()
      return { status: 'submitted', value: { accepted: true } }
    },

    async copyText(request) {
      // Private text must not reach the PowerShell fallback, which passes the
      // payload through argv where other processes of the same user can read it.
      const ok = term.copyToClipboard(String(request.text), {
        osc52Only: request.sensitivity === 'private',
      })
      if (!ok) return { status: 'unavailable', reason: 'no clipboard path available' }
      return { status: 'submitted', value: { accepted: true } }
    },
  })
```

并在同一个 `ctx.effect` 的清理函数里释放它——在 `return () => {` 块内、`restore()` 之前加入一行：

```js
      releaseLiveTui()
```

- [ ] **Step 4: 写契约测试**

在 `tests/std.test.mjs` 的 `console.log("")` 之前加入。这个测试不启动 TUI，只断言 `lib/index.js` 暴露的适配行为与句柄契约一致——用 `lib/std/adapt.js` 的纯函数 + 一个模拟句柄：

```js
// ---- index.js wiring contract ----
// lib/index.js needs a live cordis ctx, so it is not importable here. What is
// testable without one is the contract the handle must satisfy: the exact
// request/response shapes the facet's handlers will pass through.
{
  const seen = []
  const handle = {
    async interact(request) {
      seen.push(request)
      if (request.kind === "approval") {
        const { approvalOutcome } = await import("../lib/std/adapt.js")
        return approvalOutcome("rejected")
      }
      return { status: "cancelled" }
    },
  }
  const impls = createPresentationImplementations()
  const ui = impls.find((i) => i.support.kind === "UserInteraction").implementation
  const release = registerLiveTui(handle)

  const res = await ui.interact({ kind: "approval", action: "shell", summary: "run rm", risk: "high" })
  eq("the handle receives the std request unchanged",
    seen[0], { kind: "approval", action: "shell", summary: "run rm", risk: "high" })
  eq("a denial surfaces as a submitted denial", res,
    { status: "submitted", value: { decision: "denied" } })

  eq("an unsupported request shape is cancelled, not approved",
    await ui.interact({ kind: "question", fields: [] }), { status: "cancelled" })

  release()
}
```

- [ ] **Step 5: 运行全部测试**

Run: `npm run check && npm test`
Expected: 四个测试文件全绿；`check` 静默通过

- [ ] **Step 6: 手动验证既有路径没坏**

Run: `node tests/smoke.test.mjs && node tests/render.test.mjs && node tests/rewind.test.mjs`
Expected: 全绿。这三个文件覆盖了 `App` 的渲染与 rewind 的纯函数；审批/问答的抽取改的是 `lib/index.js`，它不被单测覆盖，所以**必须**在下一步用真实 TUI 冒烟。

- [ ] **Step 7: 提交**

```bash
git add lib/index.js tests/std.test.mjs
git commit -m "feat(tui): expose the TUI to the std facet through a live handle"
```

---

## Task 8: 在 facet 注册 Presentation

**Files:**
- Modify: `lib/facet.js`（`activateProtocols`）
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: `createPresentationImplementations()`（Task 6）
- Produces: `activate()` 后 `context.protocols.implement` 被调用三次（UserInteraction / Notification / CopyText）

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 `console.log("")` 之前加入：

```js
// ---- facet activation registers the presentation implementations ----
{
  const mod = await import(pathToFileURL(join(repoRoot, "lib/facet.js")).href)
  const registered = []
  const context = {
    identity: { component: "io.github.rayafriandion.dsh-oc-tui", facet: "host" },
    plan: {},
    scope: { signal: new AbortController().signal, add() {} },
    protocols: {
      agreement: () => undefined,
      client: () => undefined,
      implement(support, implementation) {
        registered.push({ support, implementation })
        return () => {}
      },
    },
    extensions: { publish: () => () => {} },
  }
  await mod.default.activate(context)
  // @dsh-std/sdk is a devDependency here, so activation proceeds.
  const kinds = registered.map((r) => r.support.kind).sort()
  eq("activation publishes the three presentation kinds", kinds, ["CopyText", "Notification", "UserInteraction"])
  ok("nothing else is published yet", registered.length === 3)
  ok("every published implementation is an object",
    registered.every((r) => r.implementation !== null && typeof r.implementation === "object"))
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `activation publishes the three presentation kinds`，实际得到 `[]`

- [ ] **Step 3: 实现**

把 `lib/facet.js` 的 `activateProtocols` 换成：

```js
// Each protocol lands in its own task; the list grows as they do.
async function activateProtocols(context) {
  const disposers = []

  const { createPresentationImplementations } = await import('./std/presentation.js')
  for (const { support, implementation } of createPresentationImplementations()) {
    disposers.push(context.protocols.implement(support, implementation))
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* teardown must not mask the original failure */ }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/std.test.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add lib/facet.js tests/std.test.mjs
git commit -m "feat(tui): register the presentation implementations on facet activation"
```

---

## Task 9: `lib/std/commands.js` — CommandRuntime

**Files:**
- Create: `lib/std/commands.js`
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: `liveTui()`（Task 1）
- Produces:
  - `COMMAND_PLACEMENT = { apiVersion: 'tui.dsh/v1alpha1', kind: 'CommandLine' }`
  - `TUI_OWNED_COMMANDS = ['settings','help','stats','new','resume','clear','cancel','rewind','quit']`
  - `createCommandRuntimeImplementation() -> implementation`，成员 `catalog(input, context)` / `execute(input, context)`
  - 依赖活体句柄的成员：`handle.commandCatalog(input)`、`handle.executeCommand(line, input)`

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 import 区加入：

```js
import { COMMAND_PLACEMENT, TUI_OWNED_COMMANDS, createCommandRuntimeImplementation } from "../lib/std/commands.js"
```

在 `console.log("")` 之前加入：

```js
// ---- command runtime ----
{
  eq("placement coordinate is the TUI command line", COMMAND_PLACEMENT,
    { apiVersion: "tui.dsh/v1alpha1", kind: "CommandLine" })
  // Must match the nine commands contributed in dsh-plugin.json.
  eq("the owned list matches the manifest", [...TUI_OWNED_COMMANDS].sort(),
    ["cancel", "clear", "help", "new", "quit", "resume", "rewind", "settings", "stats"])
  ok("model and provider are not owned", !TUI_OWNED_COMMANDS.includes("model") && !TUI_OWNED_COMMANDS.includes("provider"))

  const runtime = createCommandRuntimeImplementation()
  eq("catalog with no live TUI returns an empty catalog",
    await runtime.catalog({ contextId: "s1" }),
    { apiVersion: "commands.dsh/v1alpha1", commands: [] })
  eq("execute with no live TUI returns undefined",
    await runtime.execute({ contextId: "s1", line: "/help" }), undefined)
}

{
  const calls = []
  const runtime = createCommandRuntimeImplementation()
  const release = registerLiveTui({
    async commandCatalog(input) {
      calls.push(["catalog", input])
      return [
        { name: "help", description: "Show help" },
        { name: "stats", description: "Show stats" },
      ]
    },
    async executeCommand(line, input) {
      calls.push(["execute", line, input])
      return { kind: "success", text: "ok" }
    },
  })

  // A request for the TUI's own command line must be answered.
  const catalog = await runtime.catalog({ contextId: "s1", placement: COMMAND_PLACEMENT })
  eq("catalog is published under the std coordinate", catalog.apiVersion, "commands.dsh/v1alpha1")
  eq("catalog carries the live commands", catalog.commands.map((c) => c.name), ["help", "stats"])

  // A request for a different surface must NOT be answered: the TUI owns only
  // its own command line, and returning commands here would make them appear on
  // surfaces that cannot run them.
  eq("a foreign placement gets an empty catalog",
    (await runtime.catalog({ contextId: "s1", placement: { apiVersion: "web.dsh/v1alpha1", kind: "CommandLine" } })).commands,
    [])
  eq("an unspecified placement gets an empty catalog",
    (await runtime.catalog({ contextId: "s1" })).commands, [])

  eq("execute forwards the raw line",
    await runtime.execute({ contextId: "s1", line: "/help now", placement: COMMAND_PLACEMENT }),
    { apiVersion: "commands.dsh/v1alpha1", commandId: "help",
      result: { kind: "success", text: "ok" } })
  eq("execute on a foreign placement is not run",
    await runtime.execute({ contextId: "s1", line: "/help", placement: { apiVersion: "web.dsh/v1alpha1", kind: "CommandLine" } }),
    undefined)
  eq("the live handle saw the raw line", calls.at(-1)[1], "/help now")

  release()
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/std/commands.js'`

- [ ] **Step 3: 实现**

创建 `lib/std/commands.js`：

```js
// CommandRuntime for the TUI: the TUI *hosts* a command line, so it provides
// the runtime that lists and executes commands.
//
// It only answers for its own placement coordinate. A command published without
// placements is publishable on every surface, so filtering by placement is what
// keeps a web UI from offering /settings and /rewind, which it cannot run.

import { liveTui } from '../bridge.js'

export const COMMAND_API_VERSION = 'commands.dsh/v1alpha1'

// The TUI's own command line. Product-owned coordinates use the tui.dsh/*
// namespace, per the ecosystem governance rules.
export const COMMAND_PLACEMENT = Object.freeze({ apiVersion: 'tui.dsh/v1alpha1', kind: 'CommandLine' })

// Commands the TUI always owns. /model and /provider are deliberately absent:
// runCommand asks ctx.commands.find() first, so the harness owns them whenever
// it registers them and the TUI only supplies the fallback.
export const TUI_OWNED_COMMANDS = Object.freeze([
  'settings', 'help', 'stats', 'new', 'resume', 'clear', 'cancel', 'rewind', 'quit',
])

function placementMatches(placement) {
  return placement?.apiVersion === COMMAND_PLACEMENT.apiVersion
    && placement?.kind === COMMAND_PLACEMENT.kind
}

const EMPTY_CATALOG = Object.freeze({ apiVersion: COMMAND_API_VERSION, commands: Object.freeze([]) })

// The raw command name out of a command line, for the execution receipt. The
// standard does not define a tokenizer, so this deliberately only strips the
// leading slash and stops at the first whitespace.
function commandNameOf(line) {
  const trimmed = String(line ?? '').trim()
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  const match = /^[^\s]+/.exec(withoutSlash)
  return match ? match[0] : ''
}

export function createCommandRuntimeImplementation() {
  return {
    async catalog(input) {
      if (!placementMatches(input?.placement)) return EMPTY_CATALOG
      const handle = liveTui()
      if (!handle) return EMPTY_CATALOG
      const commands = await handle.commandCatalog(input)
      return { apiVersion: COMMAND_API_VERSION, commands: commands ?? [] }
    },

    async execute(input) {
      if (!placementMatches(input?.placement)) return undefined
      const handle = liveTui()
      if (!handle) return undefined
      const result = await handle.executeCommand(String(input.line ?? ''), input)
      if (result === undefined || result === null) return undefined
      return { apiVersion: COMMAND_API_VERSION, commandId: commandNameOf(input.line), result }
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/std.test.mjs`
Expected: 全部 `ok`

- [ ] **Step 5: 提交**

```bash
git add lib/std/commands.js tests/std.test.mjs
git commit -m "feat(tui): provide a CommandRuntime scoped to the TUI command line"
```

---

## Task 10: 接线 CommandRuntime 并注册

**Files:**
- Modify: `lib/index.js`（句柄增加 `commandCatalog` / `executeCommand`）
- Modify: `lib/facet.js`（注册 CommandRuntime）
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: `TUI_OWNED_COMMANDS`（Task 9）、`createCommandRuntimeImplementation()`（Task 9）
- Produces: 句柄成员 `commandCatalog(input) -> [{name, description}]`、`executeCommand(line, input) -> {kind, text?} | undefined`

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 `console.log("")` 之前加入：

```js
// ---- facet registers the command runtime ----
{
  const mod = await import(pathToFileURL(join(repoRoot, "lib/facet.js")).href)
  const registered = []
  const context = {
    identity: { component: "io.github.rayafriandion.dsh-oc-tui", facet: "host" },
    plan: {},
    scope: { signal: new AbortController().signal, add() {} },
    protocols: {
      agreement: () => undefined,
      client: () => undefined,
      implement(support, implementation) { registered.push({ support, implementation }); return () => {} },
    },
    extensions: { publish: () => () => {} },
  }
  await mod.default.activate(context)
  const kinds = registered.map((r) => r.support.kind).sort()
  eq("activation publishes presentation plus the command runtime", kinds,
    ["CommandRuntime", "CopyText", "Notification", "UserInteraction"])
  const runtime = registered.find((r) => r.support.kind === "CommandRuntime")
  eq("the runtime is on the commands coordinate", runtime.support.apiVersion, "commands.dsh/v1alpha1")
  ok("the runtime exposes catalog and execute",
    typeof runtime.implementation.catalog === "function" && typeof runtime.implementation.execute === "function")
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — 期望四个 kind，实际三个

- [ ] **Step 3: 在句柄上实现 catalog 与 execute**

在 `lib/index.js` 的 import 区加入：

```js
import { TUI_OWNED_COMMANDS } from './std/commands.js'
```

在 `registerLiveTui({ ... })` 的对象里、`copyText` 之后加入两个成员：

```js
    async commandCatalog() {
      // The TUI's own command line is served from the local switch in
      // runCommand; this is the discoverable view of it. Descriptions mirror
      // the manifest contributions in dsh-plugin.json.
      return TUI_OWNED_COMMANDS.map((name) => ({
        name,
        description: COMMAND_DESCRIPTIONS[name] ?? '',
      }))
    },

    async executeCommand(line) {
      // The title screen has no session for a command to act on; the standard
      // allows execute to return undefined, which is the honest answer.
      if (!currentAgent) return undefined
      const parsed = parseCommand(line)
      if (!parsed) return undefined
      if (!TUI_OWNED_COMMANDS.includes(parsed.name)) return undefined
      const result = await runCommandResult(line, parsed)
      return result
    },
```

在 `registerLiveTui` 之前加入命令描述表与一个返回结果而非只写 transcript 的执行包装：

```js
  const COMMAND_DESCRIPTIONS = {
    settings: 'Open the TUI settings pages',
    help: 'Show the TUI key and command reference',
    stats: 'Show session token and cache statistics',
    new: 'Start a new session',
    resume: 'Resume a persisted session',
    clear: 'Clear the transcript',
    cancel: 'Cancel the running turn',
    rewind: 'Rewind the session to an earlier point',
    quit: 'Leave the TUI',
  }

  // runCommand reports through the transcript/toast and returns nothing; the
  // std runtime needs the outcome. This wrapper captures the feedback that
  // runCommand would have shown and returns it as the standard's result shape,
  // without changing what the user sees.
  async function runCommandResult(line, parsed) {
    const captured = []
    const capture = (text, level = 'info') => { captured.push({ text, level }) }
    try {
      await runCommand(line, capture)
    } catch (error) {
      return { kind: 'error', text: formatError(error) }
    }
    const last = captured.at(-1)
    if (!last) return { kind: 'success' }
    return { kind: last.level === 'error' ? 'error' : 'success', text: last.text }
  }
```

并把 `runCommand` 的签名改为接受一个可选的反馈函数——把它的第一段：

```js
  async function runCommand(line) {
    const parsed = parseCommand(line)
    if (!parsed) return
    // Command feedback is a transcript line inside a session and a toast on
    // the title screen, where a system block would hide the welcome view.
    const feedback = (text, level = 'info') => {
      if (currentAgent) app.addSystem(text, level)
      else app.showToast(text, level)
      paint()
    }
```

改成：

```js
  async function runCommand(line, onFeedback) {
    const parsed = parseCommand(line)
    if (!parsed) return
    // Command feedback is a transcript line inside a session and a toast on
    // the title screen, where a system block would hide the welcome view.
    // `onFeedback` lets the std runtime capture the same text it would show.
    const feedback = (text, level = 'info') => {
      if (currentAgent) app.addSystem(text, level)
      else app.showToast(text, level)
      if (onFeedback) onFeedback(text, level)
      paint()
    }
```

（其余 `runCommand` 函数体不动。所有既有调用点 `runCommand(line)` 继续合法，因为第二个参数可选。）

- [ ] **Step 4: 在 facet 注册**

把 `lib/facet.js` 的 `activateProtocols` 换成：

```js
async function activateProtocols(context) {
  const disposers = []

  const { createPresentationImplementations } = await import('./std/presentation.js')
  for (const { support, implementation } of createPresentationImplementations()) {
    disposers.push(context.protocols.implement(support, implementation))
  }

  const { createCommandRuntimeImplementation, COMMAND_API_VERSION } = await import('./std/commands.js')
  disposers.push(context.protocols.implement(
    { apiVersion: COMMAND_API_VERSION, kind: 'CommandRuntime' },
    createCommandRuntimeImplementation(),
  ))

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* teardown must not mask the original failure */ }
    }
  }
}
```

- [ ] **Step 5: 运行全部测试**

Run: `npm run check && npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add lib/index.js lib/facet.js tests/std.test.mjs
git commit -m "feat(tui): provide and register a CommandRuntime over the local command switch"
```

---

## Task 11: `secret-input` 模态

**Files:**
- Modify: `lib/ui.js`（`App` 增加 `pendingSecret` 状态与绘制）
- Modify: `lib/index.js`（`waitForSecret` + 句柄 `interact` 的 `secret-input` 分支）
- Test: `tests/std.test.mjs`、`tests/render.test.mjs`

**Interfaces:**
- Consumes: `App.pendingSecret`（本 task 新增）
- Produces: 句柄 `interact({kind:'secret-input', ...})` 返回 `{status:'submitted', value:{secret}}` / `{status:'cancelled'}`；`presentationOperations()` 变为 `['question','approval','secret-input']`

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 `console.log("")` 之前加入：

```js
// ---- secret input ----
{
  const handle = {
    async interact(request) {
      if (request.kind !== "secret-input") return { status: "unavailable" }
      // Echoes what the modal would return, so the shim's mapping is what is
      // under test here rather than the terminal.
      return { status: "submitted", value: { secret: "s3cr3t" } }
    },
  }
  const impls = createPresentationImplementations()
  const ui = impls.find((i) => i.support.kind === "UserInteraction").implementation
  const release = registerLiveTui(handle)
  eq("secret input is forwarded to the live TUI",
    await ui.interact({ kind: "secret-input", label: "API key" }),
    { status: "submitted", value: { secret: "s3cr3t" } })
  release()
  eq("secret input with no live TUI is unavailable",
    (await ui.interact({ kind: "secret-input", label: "API key" })).status, "unavailable")
}
```

- [ ] **Step 2: 先把 Task 6 的 operations 断言改成三项，确认它失败**

Task 6 写入的断言现在写死为两项，本 task 要把它扩到三项。先改断言：

```js
  eq("user interaction operations", byKind.UserInteraction.support.spec.operations,
    ["question", "approval", "secret-input"])
  eq("presentationOperations matches the published support",
    presentationOperations(), ["question", "approval", "secret-input"])
```

Run: `node tests/std.test.mjs`
Expected: FAIL — 实际得到 `["question","approval"]`，因为 `presentationOperations()` 还没更新（Step 5 才更新）。

- [ ] **Step 3: 在 `App` 增加状态**

在 `lib/ui.js:310` 的 `this.pendingQuestions = null` 之后加入：

```js
    this.pendingSecret = null      // { label, description, draft, cursor, error, settle }
```

在 `lib/ui.js:1685` 的 `if (this.pendingQuestions) this._paintQuestions(screen, cols, rows)` 之后加入：

```js
    if (this.pendingSecret) this._paintSecret(screen, cols, rows)
```

- [ ] **Step 4: 给 secret 模态写渲染测试**

这个模态是新增的绘制路径，而 `tests/render.test.mjs` 已经为每个覆盖层（rewind、stats 条、note 折叠）
备好了 `paintCapture` / `emulatePaint` / `gridDiff` 的 "leaves no residue" 断言模式，新增覆盖层应当享有同等保障。

在 `tests/render.test.mjs` 末尾（`console.log("")` 之前）加入：

```js
// The standalone secret prompt is a new painted overlay; like every other
// overlay it must not strand cells behind it when it opens, updates or closes.
for (const [COLS, ROWS] of [[80, 24], [60, 20], [120, 40]]) {
  const { term, writes } = paintCapture(COLS, ROWS)
  const app = new App({ cols: COLS, rows: ROWS, on() {} })
  app.setSession({ id: "s", title: "Secret" })
  let screen = app.render(); term.paint(screen)

  app.pendingSecret = { label: "Provider API key", description: "Paste the key", draft: "", cursor: 0, error: null, settle() {} }
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} secret prompt open leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)

  app.pendingSecret.draft = "sk-abcdefghijklmnop"
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} secret prompt typing leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
  const rows = screen.cells.map((row) => row.map((c) => c.ch).join(""))
  // The value is masked: the plaintext must never reach the screen buffer,
  // where it would be readable by anything that dumps the frame.
  ok(`${COLS}x${ROWS} secret prompt masks the value`,
    !rows.some((row) => row.includes("sk-abcdefghijklmnop")))
  ok(`${COLS}x${ROWS} secret prompt draws the label`,
    rows.some((row) => row.includes("Provider API key")))

  app.pendingSecret.error = "a value is required"
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} secret prompt error leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)

  app.pendingSecret = null
  screen = app.render(); term.paint(screen)
  ok(`${COLS}x${ROWS} closing the secret prompt leaves no residue`,
    gridDiff(emulatePaint(writes, COLS, ROWS), screen, COLS, ROWS).length === 0)
}
```

- [ ] **Step 5: 运行渲染测试确认失败**

Run: `node tests/render.test.mjs`
Expected: FAIL — `this._paintSecret is not a function`（Step 3 只加了状态与调用点，绘制函数在 Step 6 才写）。

- [ ] **Step 6: 实现 `_paintSecret`**

在 `_paintQuestions` 之后加入绘制函数（沿用设置页已有的掩码渲染思路，`lib/ui.js:2236`）：

```js
  // A standalone masked prompt for secret-input requests. The Settings pages
  // have their own inline masked field; this is the same masking applied to a
  // one-field modal that a standard protocol request can drive.
  _paintSecret(screen, cols, rows) {
    const t = THEME
    const state = this.pendingSecret
    const width = Math.max(30, Math.min(cols - 8, 64))
    const height = state.description ? 7 : 6
    const x = Math.max(1, Math.floor((cols - width) / 2))
    const y = Math.max(1, Math.floor((rows - height) / 2))
    const panel = makeStyle({ fg: t.text, bg: t.backgroundElement })
    const border = makeStyle({ fg: t.border, bg: t.backgroundElement })
    // Screen.fill covers one row, so a panel is a per-row loop — the same shape
    // the settings dialog uses.
    for (let row = 0; row < height; row++) screen.fill(x, y + row, width, ' ', panel)
    for (let col = 0; col < width; col++) {
      screen.set(x + col, y, '─', border)
      screen.set(x + col, y + height - 1, '─', border)
    }
    for (let row = 0; row < height; row++) {
      screen.set(x, y + row, '│', border)
      screen.set(x + width - 1, y + row, '│', border)
    }
    screen.set(x, y, '┌', border); screen.set(x + width - 1, y, '┐', border)
    screen.set(x, y + height - 1, '└', border); screen.set(x + width - 1, y + height - 1, '┘', border)

    let row = y + 1
    screen.text(x + 2, row, truncateWidth(state.label, width - 4),
      makeStyle({ fg: t.accent, bold: true, bg: t.backgroundElement }))
    row += 1
    if (state.description) {
      screen.text(x + 2, row, truncateWidth(state.description, width - 4),
        makeStyle({ fg: t.textMuted, bg: t.backgroundElement }))
      row += 1
    }
    const masked = '•'.repeat(Array.from(state.draft).length)
    screen.text(x + 2, row, truncateWidth(masked, width - 4), panel)
    row += 1
    screen.text(x + 2, row,
      truncateWidth(state.error ?? 'Enter to submit · Esc to cancel', width - 4),
      makeStyle({ fg: state.error ? t.error : t.textMuted, bg: t.backgroundElement }))
  }
```


用到的 API 都是 `lib/term.js` 与 `lib/ui.js` 里已存在的：`Screen.fill(x, y, width, ch, style)`（单行）、`Screen.set`、`Screen.text`、`makeStyle`、`truncateWidth`，以及 `THEME` 的 `text` / `textMuted` / `backgroundElement` / `border` / `accent` / `error`。注意 `THEME` 里**没有** `foreground` 或 `muted` 这两个键。


- [ ] **Step 7: 在 `lib/index.js` 实现等待与分支**

在 `waitForQuestions` 之后加入：

```js
  // Wait on the standalone secret prompt. `secret-input` is the one
  // Presentation operation with no existing modal: the Settings pages mask a
  // credential inline, but there was no way to ask for a secret on its own.
  function waitForSecret({ label, description, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false
      const state = {
        label: String(label),
        description: description === undefined ? undefined : String(description),
        draft: '',
        cursor: 0,
        error: null,
        settle: (value) => {
          if (settled) return
          settled = true
          detach()
          resolve(value)
        },
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        detach()
        reject(new Error('secret-input request aborted'))
      }
      const detach = () => {
        if (signal) signal.removeEventListener('abort', onAbort)
        if (app.pendingSecret === state) app.pendingSecret = null
        paint()
      }
      if (signal) {
        if (signal.aborted) {
          reject(new Error('secret-input request aborted'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      app.pendingSecret = state
      paint()
    })
  }
```

在句柄 `interact` 的 `if (request.kind === 'question')` 分支之前加入：

```js
      if (request.kind === 'secret-input') {
        try {
          const value = await waitForSecret({
            label: request.label,
            description: request.description,
            signal: request.signal,
          })
          if (value === null) return { status: 'cancelled' }
          return { status: 'submitted', value: { secret: value } }
        } catch {
          return { status: 'cancelled' }
        }
      }
```

在键盘处理里接入该模态。落点精确在 `if (app.pendingApproval) { ... }` 块的**结束大括号之后**、`// The question modal owns every key except Ctrl+C` 注释之前（`lib/index.js:1666`），这样它优先于问题模态与其余所有输入。插入：

```js
    if (app.pendingSecret) {
      if (key.name === 'escape') {
        app.pendingSecret.settle(null)
        return
      }
      if (key.name === 'return') {
        const state = app.pendingSecret
        if (state.draft.length === 0) {
          state.error = 'a value is required'
          paint()
          return
        }
        state.settle(state.draft)
        return
      }
      if (key.name === 'backspace') {
        app.pendingSecret.draft = app.pendingSecret.draft.slice(0, -1)
        paint()
        return
      }
      if (typeof key.text === 'string' && key.text.length > 0 && !key.ctrl && !key.meta) {
        app.pendingSecret.draft += key.text
        paint()
      }
      return
    }
```

- [ ] **Step 8: 更新 operations**

把 `lib/std/presentation.js` 的 `presentationOperations` 换成：

```js
// The operations the TUI's modals genuinely implement. Everything listed here
// must have a working prompt behind it: the standard's `support` means an
// available implementation, not an intention.
export function presentationOperations() {
  return ['question', 'approval', 'secret-input']
}
```

- [ ] **Step 9: 运行全部测试**

Run: `npm run check && npm test`
Expected: 全绿（`npm test` 会跑到 `tests/render.test.mjs`，即 Step 4 新增的 secret 模态断言）

- [ ] **Step 10: 提交**

```bash
git add lib/ui.js lib/index.js lib/std/presentation.js tests/std.test.mjs tests/render.test.mjs
git commit -m "feat(tui): add the standalone secret prompt and claim secret-input"
```

---

## Task 12: `lib/std/contribution-host.js` — 第三方 UI 贡献

**Files:**
- Create: `lib/std/contribution-host.js`
- Modify: `lib/ui.js`（在 Settings 渲染贡献分区）
- Modify: `lib/index.js`（句柄 `contribute`）
- Test: `tests/std.test.mjs`

**Interfaces:**
- Consumes: `liveTui()`（Task 1）
- Produces:
  - `SETTINGS_SURFACE = { apiVersion: 'ui.dsh/v1alpha1', kind: 'SettingsSection' }`
  - `createContributionHostProvider() -> UiContributionProvider`，成员 `participantId` / `support` / `register(owner, contribution, context) -> disposer`
  - 句柄成员 `contribute(registration) -> disposer`

- [ ] **Step 1: 写失败的测试**

在 `tests/std.test.mjs` 的 import 区加入：

```js
import { SETTINGS_SURFACE, createContributionHostProvider } from "../lib/std/contribution-host.js"
```

在 `console.log("")` 之前加入：

```js
// ---- contribution host ----
{
  eq("settings surface coordinate", SETTINGS_SURFACE,
    { apiVersion: "ui.dsh/v1alpha1", kind: "SettingsSection" })

  const provider = createContributionHostProvider()
  eq("provider is on the ui coordinate", provider.support.apiVersion, "ui.dsh/v1alpha1")
  eq("provider declares the ContributionHost kind", provider.support.kind, "ContributionHost")
  // host-rendered only: local-module would require importing and running third
  // party JS, and the TUI has no sandbox.
  eq("only host-rendered content is accepted",
    provider.support.spec.surfaces.map((s) => s.modes), [["host-rendered"]])
  ok("the participant id is namespaced", /^[a-z]/.test(provider.participantId))

  // No live TUI: register must still return a disposer, but must not throw.
  const dispose = provider.register(
    { component: "other.plugin", version: "1.0.0", facet: "host", instanceId: "i1", participantId: "other.plugin/host" },
    { descriptor: { id: "other.plugin.one", surface: SETTINGS_SURFACE, content: { label: "Extra" } } },
    { agreement: {}, signal: new AbortController().signal },
  )
  ok("register returns a disposer with no live TUI", typeof dispose === "function")
  await dispose()
}

{
  const contributed = []
  const provider = createContributionHostProvider()
  const release = registerLiveTui({
    contribute(registration) {
      contributed.push(registration)
      return () => { contributed.push("disposed") }
    },
  })
  const dispose = provider.register(
    { component: "other.plugin", version: "1.0.0", facet: "host", instanceId: "i1", participantId: "other.plugin/host" },
    { descriptor: { id: "other.plugin.one", surface: SETTINGS_SURFACE, placement: "settings", content: { label: "Extra" } } },
    { agreement: {}, signal: new AbortController().signal },
  )
  eq("the contribution reached the live TUI", contributed.length, 1)
  eq("the descriptor is passed through", contributed[0].descriptor.id, "other.plugin.one")
  eq("the owner is passed through", contributed[0].owner.component, "other.plugin")
  await dispose()
  ok("disposing the lease reaches the TUI", contributed.includes("disposed"))

  // A contribution aimed at a surface the TUI does not host must be rejected,
  // not silently accepted.
  let threw = false
  try {
    provider.register(
      { component: "other.plugin", version: "1.0.0", facet: "host", instanceId: "i1", participantId: "other.plugin/host" },
      { descriptor: { id: "other.plugin.two", surface: { apiVersion: "browser.ui.dsh/v1alpha1", kind: "SettingsSection" }, content: {} } },
      { agreement: {}, signal: new AbortController().signal },
    )
  } catch { threw = true }
  ok("a foreign surface is rejected", threw)

  // local-module requires a module and host-rendered forbids one.
  threw = false
  try {
    provider.register(
      { component: "other.plugin", version: "1.0.0", facet: "host", instanceId: "i1", participantId: "other.plugin/host" },
      { descriptor: { id: "other.plugin.three", surface: SETTINGS_SURFACE, content: {} }, localModule: {} },
      { agreement: {}, signal: new AbortController().signal },
    )
  } catch { threw = true }
  ok("a local module on a host-rendered surface is rejected", threw)

  release()
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/std.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/std/contribution-host.js'`

- [ ] **Step 3: 实现**

创建 `lib/std/contribution-host.js`：

```js
// ContributionHost for the TUI: the TUI owns the terminal, so it is the only
// thing that can render a contribution. Other components register descriptors
// here and the TUI paints them.
//
// Only `host-rendered` content is accepted. `local-module` would mean importing
// and executing third-party JavaScript inside the TUI process, which has no
// sandbox — and the standard itself says products without a shared page realm
// (TUI, headless) need not implement the module mode.

import { liveTui } from '../bridge.js'

export const UI_API_VERSION = 'ui.dsh/v1alpha1'
export const CONTRIBUTION_HOST_KIND = 'ContributionHost'

// The one surface the TUI hosts today. The Settings pages already have stable
// section rendering (lib/web-settings.js SETTINGS_MENU), so a contribution has
// somewhere predictable to land.
export const SETTINGS_SURFACE = Object.freeze({ apiVersion: UI_API_VERSION, kind: 'SettingsSection' })

const PARTICIPANT_ID = 'io.github.rayafriandion.dsh-oc-tui/host'

function sameSurface(left, right) {
  return left?.apiVersion === right.apiVersion && left?.kind === right.kind
}

export function createContributionHostProvider() {
  return {
    participantId: PARTICIPANT_ID,
    support: {
      apiVersion: UI_API_VERSION,
      kind: CONTRIBUTION_HOST_KIND,
      spec: { surfaces: [{ ...SETTINGS_SURFACE, modes: ['host-rendered'] }] },
    },

    register(owner, contribution, context) {
      const descriptor = contribution?.descriptor
      if (!descriptor || typeof descriptor.id !== 'string') {
        throw new TypeError('a ui contribution needs a descriptor with an id')
      }
      if (!sameSurface(descriptor.surface, SETTINGS_SURFACE)) {
        throw new TypeError(
          'unsupported ui surface ' + String(descriptor.surface?.apiVersion) + ' ' + String(descriptor.surface?.kind))
      }
      if (contribution.localModule !== undefined) {
        throw new TypeError('local-module contributions are not supported; only host-rendered content')
      }

      // No live TUI: the registration is accepted and dropped, and the returned
      // disposer is a no-op. Throwing here would turn "the TUI is not running"
      // into a component activation failure.
      const handle = liveTui()
      if (!handle) return () => {}

      return handle.contribute({ owner, descriptor, context })
    },
  }
}
```

- [ ] **Step 4: 在句柄与 `App` 上实现渲染**

在 `lib/ui.js:310` 的 `this.pendingSecret = null` 之后加入：

```js
    this.contributions = []        // [{ owner, descriptor }] from std components
```

在 `App` 上加两个方法（放在 `addNote` 附近）：

```js
  // Third-party UI contributions (ui.dsh/v1alpha1 ContributionHost). The TUI
  // only hosts host-rendered content, so a contribution is data the TUI paints
  // in its own style — never code it runs.
  addContribution(owner, descriptor) {
    this.contributions.push({ owner, descriptor })
  }

  removeContribution(descriptorId) {
    const index = this.contributions.findIndex((c) => c.descriptor.id === descriptorId)
    if (index >= 0) this.contributions.splice(index, 1)
  }
```

在 Settings 项列表里追加贡献行。落点是 `lib/index.js` 的 `showSettings`——它是所有 Settings 标签页（main / model / update / sessions）汇合到 `app.openSettings` 的唯一位置，所以在这里追加能让贡献在切换标签页后依然可见。把 `showSettings` 换成：

```js
  function showSettings(loaded, selection = 0) {
    sharedSettings = loaded.settings
    // Third-party UI contributions (ui.dsh/v1alpha1 ContributionHost) render as
    // read-only rows after the built-in ones. Read-only because writing back
    // would need the storage protocol, which the TUI does not adopt yet.
    // The row shape is the same one the "Settings file" row uses: no `kind`,
    // `disabled: true` — which lib/index.js:2272 already treats as
    // non-activatable.
    const items = loaded.items.slice()
    for (const { descriptor } of app.contributions) {
      items.push({
        label: String(descriptor.content?.label ?? descriptor.id),
        value: String(descriptor.content?.value ?? ''),
        disabled: true,
      })
    }
    app.openSettings(items, {
      title: loaded.title,
      subtitle: loaded.subtitle,
      menu: loaded.menu ?? [],
      menuIndex: loaded.menuIndex ?? 0,
    })
    app.setSettingsSelection(selection)
  }
```

在 `lib/index.js` 的句柄对象里、`commandCatalog` 之前加入：

```js
    contribute({ owner, descriptor }) {
      app.addContribution(owner, descriptor)
      paint()
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        app.removeContribution(descriptor.id)
        paint()
      }
    },
```

- [ ] **Step 5: 在 facet 注册**

在 `lib/facet.js` 的 `activateProtocols` 里、CommandRuntime 之后加入：

```js
  const { createContributionHostProvider } = await import('./std/contribution-host.js')
  const provider = createContributionHostProvider()
  disposers.push(context.protocols.implement(provider.support, provider))
```

- [ ] **Step 6: 运行全部测试**

Run: `npm run check && npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add lib/std/contribution-host.js lib/ui.js lib/index.js lib/facet.js tests/std.test.mjs
git commit -m "feat(tui): host host-rendered ui contributions in the settings pages"
```

---

## Task 13: 文档

**Files:**
- Create: `docs/dsh-std-接入说明.md`
- Modify: `README.md`
- Modify: `docs/用户手册.md`

**Interfaces:**
- Consumes: 前面所有 task 的产物
- Produces: 文档

- [ ] **Step 1: 写接入说明**

创建 `docs/dsh-std-接入说明.md`，必须覆盖：

- 本插件在 `@dsh-std` 生态里的角色：**Host 与 Presentation 提供方**，不是协议消费方；
- **为什么 facet 不拥有 TUI 的生命周期**：adapter 的 `mountProfileComponents` 无条件挂载 profile `dependencies` 里每个 `dsh-plugin.json` 的 facet，而 TUI 已由 `cordis.patch.yml` 的 bundle 行激活；TUI 抢占终端，两份会互抢 raw mode / 备用屏 / 鼠标跟踪。因此 `lib/facet.js` 只是协议外壳，`snapshot()` 在无活体 TUI 时报 `degraded`；
- `dsh-plugin.json` 各字段的含义，特别是**为什么 `requires.contracts` 只有 `commands.dsh/v1alpha1 Command`**（Community v0.15 没有 `supports` 字段，提供的协议只能运行时由 `implement()` 产生，多写即虚假声明）；
- **为什么命令走 `x-dev.dsh-std.extensions` 富路径**（简单 `contributes.commands` 的投影会丢掉 `placements` 与 `aliases`）；
- 依赖 pin 的原因（npm `latest` tag 落后于 git main，最新版在 `rc` tag 上）与具体版本号；
- `lib/bridge.js` 的契约（晚绑定、幂等释放）与「facet 不启动 TUI」这条硬约束的原因；
- 当前**不实现**的协议与原因（`OpenExternal`、`ExternalRedirect`、`local-module`、Session、Storage）；
- 当前**无法**做到的事（无 conformance suite；不能注册进 `dsh-ecosystem-spec`）。

- [ ] **Step 2: README 增补**

在 `README.md` 的架构/插件说明部分新增一节，用中文说明 dsh-std 接入的范围，并**显式写出双激活已由设计规避**——否则下一个人看到 `dsh-plugin.json` 里有一个不会启动 TUI 的 facet，会以为是 bug。

- [ ] **Step 3: 用户手册增补**

在 `docs/用户手册.md` 的 Settings 一节补充：第三方插件可以在设置页追加只读分区（`ui.dsh/v1alpha1` 的 `host-rendered` 贡献）。

- [ ] **Step 4: 提交**

```bash
git add docs/dsh-std-接入说明.md README.md docs/用户手册.md
git commit -m "docs(tui): explain the dsh-std interop scope and the facet constraint"
```

---

## Task 14: 真实 TUI 冒烟（不可省略）

**Files:** 无代码改动。这是 Task 7 / 11 / 12 改动的验证关卡——`lib/index.js` 与 `lib/ui.js` 的改动不被单测覆盖，只有真实终端能验证。

**Interfaces:**
- Consumes: 全部前面的产物
- Produces: 验证结论（若失败，回到对应 task 修复）

- [ ] **Step 1: 装到本地 profile 并启动**

Run:
```bash
npm pack
dsh plugin --profile tui add ./dsh-oc-tui-0.1.3.tgz
dsh --profile tui
```
Expected: TUI 正常启动，标题栏与 composer 正常渲染。

- [ ] **Step 2: 验证既有交互没坏**

在 TUI 内依次验证：

1. 发一条普通消息 → 正常流式回复；
2. 触发一次需要审批的工具调用 → 审批模态出现，`y` 允许、`n` 拒绝都能正常继续；
3. 输入 `/help`、`/stats`、`/settings` → 与改动前行为一致；
4. `Ctrl+P` → Settings 正常打开，凭据项仍以掩码显示；
5. `Esc Esc` 或 `/rewind` → rewind 正常。

Expected: 五项全部与改动前一致。**任何一项回归都必须回到 Task 7 修复**——`awaitApproval` / `waitForQuestions` 的抽取是这次改动里风险最高的一处。

- [ ] **Step 3: 验证 private 复制路径**

在 TUI 内复制一段内容（确认走 OSC 52 而非 PowerShell），然后确认 Windows 上 `powershell.exe` 没有因为复制而被拉起：

Run（另一个终端）:
```bash
tasklist | grep -i powershell
```
Expected: 没有由 TUI 复制动作产生的新 `powershell.exe` 进程。

- [ ] **Step 4: 卸载临时安装**

Run:
```bash
dsh plugin --profile tui remove dsh-oc-tui
rm dsh-oc-tui-0.1.3.tgz
```
Expected: profile 回到干净状态。

- [ ] **Step 5: 记录结论**

在 `docs/dsh-std-接入说明.md` 末尾追加一节「验证记录」，写明确切日期、验证过的五项交互、以及任何未覆盖的路径。若某项未能验证，如实写明「未验证」而不是省略。

必须如实记录的两条未覆盖路径：

- **secret 模态无法在此手动验证。** 它只由标准协议的 `secret-input` 请求触发，而验证用的 profile 里没有任何 std 消费方会发出该请求。它的保障来自 Task 11 Step 4 的渲染测试，不是来自这次冒烟——文档里要这样写，不能写成"已验证"。
- **`commandCatalog` / `executeCommand` 句柄没有真实调用方。** 同理，只有 std 消费方会走 `CommandRuntime`；本仓库自有的斜杠命令走的是 `runCommand` 的本地 switch，不经过句柄。

```bash
git add docs/dsh-std-接入说明.md
git commit -m "docs(tui): record the manual smoke results for the std interop"
```

---

## 自审记录

**Spec 覆盖：**

| Spec 章节 | 对应 task |
|---|---|
| §4.2 `lib/bridge.js` 晚绑定注册表 | Task 1 |
| §5.1 `dsh-plugin.json` | Task 2 |
| §5.3 `lib/facet.js` | Task 3、8、10、12 |
| §5.4 `package.json` 变更 | Task 3 |
| §6.1 B1a Presentation（question/approval/notification/copyText） | Task 4、6、7、8 |
| §6.1 B1b Presentation（secret-input） | Task 11 |
| §6.2 B2 CommandRuntime | Task 9、10 |
| §6.3 B3 ContributionHost | Task 12 |
| §7 错误与边界（unavailable / private 复制） | Task 5、6、7、9 |
| §8 测试计划 | 全部 task 的测试步骤 |
| §9 文档更新 | Task 13 |
| §10 已知限制 | Task 13 的接入说明 |
| 人工验证（spec §8 未覆盖的真实终端路径） | Task 14 |

**已知的、刻意留下的不一致：** 命令同时存在于 `dsh-plugin.json` 的静态贡献与 `lib/std/commands.js` 的 `TUI_OWNED_COMMANDS`（Task 9 的测试断言两者一致）。这是 spec §10 第 2 条记录的限制——静态贡献用于发现与预检，本地列表是执行路径。测试把两者钉在一起，所以任何一侧改动都会失败，不会静默漂移。
